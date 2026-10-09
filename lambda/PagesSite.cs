// GenHTTP Pages - serves a static site the way GitHub Pages does.
//
// This file is written into the lambda by the genhttp-pages GitHub Action
// (https://github.com/Kaliumhexacyanoferrat/genhttp-pages) on every deployment.
// Change it there, not here: the next deployment replaces it.
//
// The action uploads the site below resources/ and describes it in
// resources/pages.json: for every path of the site, the resource it was stored
// as and an entity tag. Names a lambda cannot hold as a resource (spaces,
// deep folders, dot files, no extension) are stored under a neutral name in
// resources/blobs/, which is why the site is served through that map rather
// than straight from the folder.
//
// What a request gets, as on GitHub Pages:
//
//   /docs/           docs/index.html (or index.htm)
//   /about           about, else about.html, else a redirect to about/ when that is a folder
//   /repo/about      the same as /about, for sites built for a project page at /repo/
//   anything else    404.html with status 404, or a plain page when the site has none
//
// Every answer allows any origin and may be cached for ten minutes; the
// platform tags it and answers 304 to a client that has it already.

/// <summary>
/// The static site this lambda serves.
/// </summary>
public static class PagesSite
{

    /// <summary>
    /// A handler serving the site as GitHub Pages would.
    /// </summary>
    /// <remarks>
    /// Add it last to a layout of your own to put routes beside the site:
    /// <c>Layout.Create().Add("api", api).Add(PagesSite.Create())</c>.
    /// </remarks>
    public static IHandlerBuilder Create()
        => Layout.Create()
                 .Add(new PagesHandler(PagesManifest.Load()));

}

/// <summary>
/// One file of the site: the resource it is stored as, and its entity tag.
/// </summary>
public sealed record PagesEntry(string Stored, string Tag);

/// <summary>
/// What the action wrote into resources/pages.json.
/// </summary>
public sealed class PagesManifest
{
    public const string Name = "pages.json";

    /// <summary>Every file of the site by its path, without a leading slash.</summary>
    public Dictionary<string, PagesEntry> Files { get; } = new(StringComparer.Ordinal);

    /// <summary>The folders the site may also be reached below, such as "repo" for a project page.</summary>
    public List<string> BasePaths { get; } = [];

    /// <summary>Whether a request for a folder without its slash is sent on to it.</summary>
    public bool Folders { get; private set; } = true;

    /// <summary>Whether "about" is answered with "about.html".</summary>
    public bool HtmlExtensions { get; private set; } = true;

    /// <summary>The headers every answer carries.</summary>
    public List<(string Name, string Value)> Headers { get; } = [];

    public static PagesManifest Load()
    {
        var manifest = new PagesManifest();

        if (!Resources.Exists(Name))
        {
            return manifest;
        }

        using var document = JsonDocument.Parse(Resources.ReadText(Name));

        var root = document.RootElement;

        if (root.TryGetProperty("files", out var files))
        {
            foreach (var file in files.EnumerateObject())
            {
                // [stored, tag]
                var stored = file.Value[0].GetString();
                var tag = file.Value[1].GetString();

                manifest.Files[file.Name] = new PagesEntry(stored, tag);
            }
        }

        if (root.TryGetProperty("basePaths", out var bases))
        {
            foreach (var basePath in bases.EnumerateArray())
            {
                var trimmed = basePath.GetString()?.Trim('/');

                if (!string.IsNullOrEmpty(trimmed))
                {
                    manifest.BasePaths.Add(trimmed);
                }
            }
        }

        if (root.TryGetProperty("headers", out var headers))
        {
            foreach (var header in headers.EnumerateObject())
            {
                manifest.Headers.Add((header.Name, header.Value.GetString() ?? string.Empty));
            }
        }

        if (root.TryGetProperty("folderRedirects", out var folders))
        {
            manifest.Folders = folders.GetBoolean();
        }

        if (root.TryGetProperty("htmlExtensions", out var html))
        {
            manifest.HtmlExtensions = html.GetBoolean();
        }

        return manifest;
    }

}

/// <summary>
/// Finds what a request asks for, and answers with it.
/// </summary>
public sealed class PagesHandler(PagesManifest manifest) : IHandler
{
    private static readonly string[] IndexFiles = ["index.html", "index.htm"];

    private readonly ConcurrentDictionary<string, IResource> _resources = new(StringComparer.Ordinal);

    private IResourceTree _tree;

    public ValueTask PrepareAsync(IServer server) => ValueTask.CompletedTask;

    public async ValueTask<IResponse> HandleAsync(IRequest request)
    {
        var method = request.Header.Method;

        if (method != RequestMethod.Get && method != RequestMethod.Head)
        {
            return request.Respond()
                          .Status(ResponseStatus.MethodNotAllowed)
                          .Header("Allow", "GET, HEAD")
                          .Content("Method not allowed", ContentType.TextPlain)
                          .Build();
        }

        var requested = request.Header.Target.AsString(true, true).TrimStart('/');

        var found = Find(requested);

        if (found == null)
        {
            // a site built for a project page links to /repo/... - the same
            // files, one folder further down
            foreach (var basePath in manifest.BasePaths)
            {
                if (requested == basePath)
                {
                    found = Found.Redirect(Last(basePath) + "/");
                    break;
                }

                if (requested.StartsWith(basePath + "/", StringComparison.Ordinal))
                {
                    found = Find(requested[(basePath.Length + 1)..]);

                    if (found != null)
                    {
                        break;
                    }
                }
            }
        }

        if (found?.Location is { } location)
        {
            return Decorate(request.Respond()
                                   .Status(ResponseStatus.MovedPermanently)
                                   .Header("Location", location + Query(request)))
                   .Build();
        }

        if (found?.Entry is { } entry && await ResourceOf(entry) is { } resource)
        {
            // the platform tags the answer and answers 304 itself; a tag of
            // our own would be sent twice by GenHTTP 11.0.5 (fixed in #936)
            return Decorate(request.Respond()
                                   .Content(resource, TypeOf(found.Name)))
                   .Build();
        }

        return await NotFound(request);
    }

    /// <summary>
    /// What a path of the site leads to: a file, a redirect, or nothing.
    /// </summary>
    private Found Find(string requested)
    {
        if (requested.Length == 0 || requested.EndsWith('/'))
        {
            foreach (var index in IndexFiles)
            {
                if (manifest.Files.TryGetValue(requested + index, out var entry))
                {
                    return Found.Hit(requested + index, entry);
                }
            }

            return null;
        }

        if (manifest.Files.TryGetValue(requested, out var exact))
        {
            return Found.Hit(requested, exact);
        }

        if (manifest.HtmlExtensions && manifest.Files.TryGetValue(requested + ".html", out var html))
        {
            return Found.Hit(requested + ".html", html);
        }

        if (manifest.Folders)
        {
            foreach (var index in IndexFiles)
            {
                if (manifest.Files.ContainsKey(requested + "/" + index))
                {
                    // relative, so it also holds below a feature's preview
                    return Found.Redirect(Last(requested) + "/");
                }
            }
        }

        return null;
    }

    private async ValueTask<IResponse> NotFound(IRequest request)
    {
        IResponseBuilder response;

        if (manifest.Files.TryGetValue("404.html", out var page) && await ResourceOf(page) is { } resource)
        {
            response = request.Respond().Content(resource, TypeOf("404.html"));
        }
        else
        {
            response = request.Respond().Content(NotFoundPage, TypeOf("404.html"));
        }

        return Decorate(response.Status(ResponseStatus.NotFound)).Build();
    }

    private IResponseBuilder Decorate(IResponseBuilder response)
    {
        response.Header("Access-Control-Allow-Origin", "*")
                .Header("Cache-Control", "max-age=600");

        foreach (var (name, value) in manifest.Headers)
        {
            response.Header(name, value);
        }

        return response;
    }

    /// <summary>
    /// The resource a file was stored as, found once and kept.
    /// </summary>
    private async ValueTask<IResource> ResourceOf(PagesEntry entry)
    {
        if (_resources.TryGetValue(entry.Stored, out var known))
        {
            return known;
        }

        _tree ??= Resources.Tree();

        IResourceContainer container = _tree;

        var segments = entry.Stored.Split('/');

        for (var i = 0; i < segments.Length - 1; i++)
        {
            var node = await container.TryGetNodeAsync(new PathSegment(segments[i]));

            if (node == null)
            {
                return null;
            }

            container = node;
        }

        var resource = await container.TryGetResourceAsync(new PathSegment(segments[^1]));

        if (resource != null)
        {
            _resources[entry.Stored] = resource;
        }

        return resource;
    }

    private static string Query(IRequest request)
    {
        var query = request.Header.Query;

        if (query.Count == 0)
        {
            return string.Empty;
        }

        var parts = new List<string>(query.Count);

        for (var i = 0; i < query.Count; i++)
        {
            var pair = query.GetStringEntry(i);

            // as the client sent them, still encoded
            var key = pair.Key.ToString();
            var value = pair.Value.ToString();

            parts.Add(value.Length == 0 ? key : key + "=" + value);
        }

        return "?" + string.Join("&", parts);
    }

    private static string Last(string requested)
    {
        var slash = requested.LastIndexOf('/');

        return slash < 0 ? requested : requested[(slash + 1)..];
    }

    #region Content types

    private static ContentType TypeOf(string name)
    {
        var slash = name.LastIndexOf('/');
        var dot = name.LastIndexOf('.');

        var extension = dot > slash ? name[(dot + 1)..].ToLowerInvariant() : string.Empty;

        return new ContentType(Types.TryGetValue(extension, out var type) ? type : "application/octet-stream");
    }

    private const string Utf8 = "; charset=utf-8";

    private static readonly Dictionary<string, string> Types = new(StringComparer.Ordinal)
    {
        ["html"] = "text/html" + Utf8, ["htm"] = "text/html" + Utf8, ["xhtml"] = "application/xhtml+xml",
        ["css"] = "text/css" + Utf8, ["js"] = "application/javascript" + Utf8, ["mjs"] = "application/javascript" + Utf8,
        ["cjs"] = "application/javascript" + Utf8, ["map"] = "application/json" + Utf8, ["json"] = "application/json" + Utf8,
        ["jsonld"] = "application/ld+json", ["webmanifest"] = "application/manifest+json", ["wasm"] = "application/wasm",
        ["xml"] = "application/xml", ["rss"] = "application/rss+xml", ["atom"] = "application/atom+xml",
        ["xsl"] = "application/xml", ["txt"] = "text/plain" + Utf8, ["md"] = "text/markdown" + Utf8,
        ["markdown"] = "text/markdown" + Utf8, ["csv"] = "text/csv" + Utf8, ["tsv"] = "text/tab-separated-values" + Utf8,
        ["yml"] = "text/yaml" + Utf8, ["yaml"] = "text/yaml" + Utf8, ["toml"] = "application/toml",
        ["ics"] = "text/calendar", ["vcf"] = "text/vcard", ["vtt"] = "text/vtt", ["srt"] = "application/x-subrip",
        ["png"] = "image/png", ["jpg"] = "image/jpeg", ["jpeg"] = "image/jpeg", ["gif"] = "image/gif",
        ["webp"] = "image/webp", ["avif"] = "image/avif", ["svg"] = "image/svg+xml", ["svgz"] = "image/svg+xml",
        ["ico"] = "image/x-icon", ["bmp"] = "image/bmp", ["tif"] = "image/tiff", ["tiff"] = "image/tiff",
        ["apng"] = "image/apng", ["jxl"] = "image/jxl", ["heic"] = "image/heic",
        ["woff"] = "font/woff", ["woff2"] = "font/woff2", ["ttf"] = "font/ttf", ["otf"] = "font/otf",
        ["eot"] = "application/vnd.ms-fontobject",
        ["mp3"] = "audio/mpeg", ["wav"] = "audio/wav", ["ogg"] = "audio/ogg", ["oga"] = "audio/ogg",
        ["m4a"] = "audio/mp4", ["flac"] = "audio/flac", ["opus"] = "audio/opus", ["weba"] = "audio/webm",
        ["mp4"] = "video/mp4", ["m4v"] = "video/mp4", ["webm"] = "video/webm", ["ogv"] = "video/ogg",
        ["mov"] = "video/quicktime", ["avi"] = "video/x-msvideo", ["mkv"] = "video/x-matroska",
        ["pdf"] = "application/pdf", ["zip"] = "application/zip", ["gz"] = "application/gzip",
        ["tgz"] = "application/gzip", ["tar"] = "application/x-tar", ["7z"] = "application/x-7z-compressed",
        ["epub"] = "application/epub+zip", ["doc"] = "application/msword", ["rtf"] = "application/rtf",
        ["docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ["xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ["pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ["glb"] = "model/gltf-binary", ["gltf"] = "model/gltf+json",
        ["pem"] = "application/x-pem-file", ["asc"] = "text/plain" + Utf8, ["sig"] = "application/pgp-signature",
    };

    #endregion

    private const string NotFoundPage = """
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found</title>
        <style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#24292f;background:#fff}
        @media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:4rem;margin:0}</style></head>
        <body><main><h1>404</h1><p>There isn't a page here.</p><p><a href="./" style="color:inherit">Go to the start page</a></p></main></body>
        </html>
        """;

    /// <summary>A file to answer with, or where to send the client instead.</summary>
    private sealed record Found(string Name, PagesEntry Entry, string Location)
    {
        public static Found Hit(string name, PagesEntry entry) => new(name, entry, null);

        public static Found Redirect(string location) => new(null, null, location);
    }

}
