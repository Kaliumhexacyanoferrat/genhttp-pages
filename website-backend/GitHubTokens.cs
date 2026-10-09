// Verifies the OIDC tokens GitHub Actions issues to workflow runs.
//
// A run with "permissions: id-token: write" may ask GitHub for a token that
// says which repository, branch and workflow it belongs to - signed by GitHub,
// for an audience the run names. Checking the signature against the keys
// GitHub publishes is what lets this site trust a run without a secret.
//
// https://docs.github.com/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect

using System.Net.Http;
using System.Security.Cryptography;

/// <summary>Who a verified token says the run is.</summary>
/// <param name="Repository">owner/name, as it is called now</param>
/// <param name="RepositoryId">GitHub's id of the repository, which outlives a rename</param>
/// <param name="OwnerId">GitHub's id of its owner</param>
public record GitHubRun(string Repository, string RepositoryId, string OwnerId, string Ref, string Workflow);

public static class GitHubTokens
{
    public const string Issuer = "https://token.actions.githubusercontent.com";

    /// <summary>What a token has to be issued for: this site.</summary>
    public const string Audience = "https://pages.genhttp.run";

    private static readonly TimeSpan Skew = TimeSpan.FromMinutes(2);

    private static readonly HttpClient Client = new() { Timeout = TimeSpan.FromSeconds(15) };

    private static readonly SemaphoreSlim Gate = new(1, 1);

    private static Dictionary<string, RSAParameters> _keys = new();

    private static DateTime _fetched = DateTime.MinValue;

    public static async Task<GitHubRun> VerifyAsync(string token)
    {
        var parts = (token ?? string.Empty).Split('.');

        if (parts.Length != 3)
        {
            throw Refused("This is not a token GitHub issued.");
        }

        string kid;

        using (var header = JsonDocument.Parse(Decode(parts[0])))
        {
            kid = Text(header.RootElement, "kid");

            if (Text(header.RootElement, "alg") != "RS256" || kid == null)
            {
                throw Refused("The token is not signed the way GitHub signs.");
            }
        }

        var key = await KeyAsync(kid) ?? throw Refused("The token is not signed by GitHub.");

        using (var rsa = RSA.Create())
        {
            rsa.ImportParameters(key);

            var signed = Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]);

            if (!rsa.VerifyData(signed, Decode(parts[2]), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
            {
                throw Refused("The signature of the token does not hold.");
            }
        }

        using var payload = JsonDocument.Parse(Decode(parts[1]));

        var claims = payload.RootElement;

        if (Text(claims, "iss") != Issuer)
        {
            throw Refused("The token was not issued by GitHub Actions.");
        }

        if (!ForUs(claims))
        {
            throw Refused($"The token is not meant for this site: ask for one with the audience {Audience}.");
        }

        var now = DateTimeOffset.UtcNow;

        if (!claims.TryGetProperty("exp", out var exp) || DateTimeOffset.FromUnixTimeSeconds(exp.GetInt64()) < now - Skew)
        {
            throw Refused("The token has expired.");
        }

        if (claims.TryGetProperty("nbf", out var nbf) && DateTimeOffset.FromUnixTimeSeconds(nbf.GetInt64()) > now + Skew)
        {
            throw Refused("The token is not valid yet.");
        }

        var repository = Text(claims, "repository");
        var repositoryId = Text(claims, "repository_id");
        var ownerId = Text(claims, "repository_owner_id");

        if (string.IsNullOrEmpty(repository) || string.IsNullOrEmpty(repositoryId) || string.IsNullOrEmpty(ownerId))
        {
            throw Refused("The token does not say which repository it is from.");
        }

        return new GitHubRun(repository, repositoryId, ownerId, Text(claims, "ref"), Text(claims, "workflow"));
    }

    private static bool ForUs(JsonElement claims)
    {
        if (!claims.TryGetProperty("aud", out var aud))
        {
            return false;
        }

        if (aud.ValueKind == JsonValueKind.String)
        {
            return aud.GetString() == Audience;
        }

        return aud.ValueKind == JsonValueKind.Array && aud.EnumerateArray().Any(a => a.GetString() == Audience);
    }

    /// <summary>
    /// GitHub's key of that id, from the set it publishes - read again after
    /// an hour, or when a token names a key that is not known yet.
    /// </summary>
    private static async Task<RSAParameters?> KeyAsync(string kid)
    {
        if (_keys.TryGetValue(kid, out var known) && DateTime.UtcNow - _fetched < TimeSpan.FromHours(1))
        {
            return known;
        }

        await Gate.WaitAsync();

        try
        {
            // at most once a minute, so made-up key ids cannot make us hammer GitHub
            if (DateTime.UtcNow - _fetched > TimeSpan.FromMinutes(1))
            {
                _keys = await FetchAsync();
                _fetched = DateTime.UtcNow;
            }

            return _keys.TryGetValue(kid, out var key) ? key : null;
        }
        finally
        {
            Gate.Release();
        }
    }

    private static async Task<Dictionary<string, RSAParameters>> FetchAsync()
    {
        var text = await Client.GetStringAsync(Issuer + "/.well-known/jwks");

        using var document = JsonDocument.Parse(text);

        var keys = new Dictionary<string, RSAParameters>();

        if (document.RootElement.TryGetProperty("keys", out var published))
        {
            foreach (var key in published.EnumerateArray())
            {
                if (Text(key, "kty") == "RSA" && Text(key, "kid") is { } kid && Text(key, "n") is { } n && Text(key, "e") is { } e)
                {
                    keys[kid] = new RSAParameters { Modulus = Decode(n), Exponent = Decode(e) };
                }
            }
        }

        return keys;
    }

    private static byte[] Decode(string base64Url)
    {
        var text = base64Url.Replace('-', '+').Replace('_', '/');

        try
        {
            return Convert.FromBase64String(text.PadRight(text.Length + (4 - text.Length % 4) % 4, '='));
        }
        catch (FormatException)
        {
            throw Refused("This is not a token GitHub issued.");
        }
    }

    private static string Text(JsonElement json, string name)
        => json.ValueKind == JsonValueKind.Object && json.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static ProviderException Refused(string message) => new(ResponseStatus.Unauthorized, message);
}
