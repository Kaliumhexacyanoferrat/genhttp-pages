# GenHTTP Pages

Publish your GitHub Pages site to [GenHTTP Lambda](https://genhttp.dev/) instead.
A drop-in replacement for `actions/deploy-pages`: keep your workflow, change the
step that deploys, and hand it a key.

```diff
     steps:
       - id: deployment
-        uses: actions/deploy-pages@v5
+        uses: Kaliumhexacyanoferrat/genhttp-pages@v1
+        with:
+          key: ${{ secrets.GENHTTP_KEY }}
```

**[pages.genhttp.run](https://pages.genhttp.run/)** walks you through it: it
creates the lambda that hosts your site, tells you where to put its key, and
rewrites your workflow. That page is published by this action, from this
repository ([`docs.yml`](.github/workflows/docs.yml)).

## Why not just GitHub Pages?

The same files, served the same way, plus what a static host cannot do:

- **Code on the server** when the site needs it: a form, an API, a proxy that
  keeps a key from the browser, a SQLite database, websockets
  ([`backend`](#a-backend-beside-the-site)).
- **Traffic statistics** counted on the server - no script, no cookie.
- **A request log** with what failed, what your code printed and its errors.
- **Every deployment a version**, one click to put an older one back.
- **Previews** of pull requests (`preview: true`), and no account.

GitHub is ahead on size (1 GB against 32 MB on the free tier), on free custom
domains, and on keeping an unvisited site forever - see
[what is different](#what-is-different-from-github-pages).

## Getting started

1. **Create a lambda** at [pages.genhttp.run](https://pages.genhttp.run/#setup),
   or with the API:
   `curl -X POST https://genhttp.dev/api/v1/lambdas -H 'Content-Type: application/json' -d '{"publicKey":"my-site","acceptedTerms":true}'`.
   Keep its `privateKey`, the editor key: it is shown once and is the only way
   to change the lambda.
2. **Store the key** as the repository secret `GENHTTP_KEY`
   (`gh secret set GENHTTP_KEY`).
3. **Change the workflow** as above. Your build, `actions/upload-pages-artifact`,
   the `github-pages` environment and the permissions stay as they are.
4. **Push.** The run publishes to `https://my-site.genhttp.run/` and links it,
   as `page_url`, from its summary.

The action cannot create the lambda by itself: a workflow's `GITHUB_TOKEN` may
not write secrets, and printing a new key into the log of a public repository
would give it to everybody. Without a key, the run fails with what to do.

## Three ways to get the site

### The Pages artifact (default)

What `actions/deploy-pages` does: the artifact uploaded by
`actions/upload-pages-artifact` earlier in the run, named by `artifact_name`.

### A branch, like "Deploy from a branch"

GitHub publishes a branch without a workflow; this needs one, which does the
same - it builds the branch with Jekyll unless it has a `.nojekyll` file:

```yaml
on:
  push:
    branches: [gh-pages]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: Kaliumhexacyanoferrat/genhttp-pages@v1
        with:
          key: ${{ secrets.GENHTTP_KEY }}
          branch: gh-pages
          folder: /            # or /docs
```

Jekyll runs in `actions/jekyll-build-pages`, as on GitHub, so it needs a Linux
runner.

### A folder

No artifact needed:

```yaml
      - uses: actions/checkout@v7
      - run: npm ci && npm run build
      - uses: Kaliumhexacyanoferrat/genhttp-pages@v1
        with:
          key: ${{ secrets.GENHTTP_KEY }}
          path: dist
```

## Inputs

Every input of `actions/deploy-pages` is accepted, so a workflow keeps working:

| Input | Default | |
|---|---|---|
| `artifact_name` | `github-pages` | The artifact to publish. |
| `timeout` | `600000` | Milliseconds to wait for the upload. |
| `preview` | `false` | Publish to a feature of the lambda instead, with an address of its own, named after the pull request (`preview-pr-12`). Delete it in the editor when done. |
| `token` | `github.token` | Only used to check out `branch`. |
| `error_count`, `reporting_interval` | | Accepted, not used: a lambda answers at once, there is nothing to poll. |

And its own:

| Input | Default | |
|---|---|---|
| `key` | | The lambda's editor key, from a secret. Left out, `$GENHTTP_KEY` is read. |
| `path` | | Publish this folder instead of an artifact. |
| `branch` | | Publish this branch. |
| `folder` | `/` | With `branch`: the folder to publish. |
| `jekyll` | `auto` | With `branch`: `auto` builds unless there is a `.nojekyll`, `true` always, `false` never. |
| `include_hidden_files` | `false` | With `path` or `branch`: publish dot files (`.well-known/`). An artifact holds what its upload included. |
| `base_path` | `auto` | Also serve the site below these folders. `auto`: below `/<repository>/` for a project site, which is what it was built for; nothing for a user site or one with a `CNAME`. `none`, or paths separated by commas. |
| `backend` | | A folder of C# to publish beside the site (see below). |
| `server` | `https://genhttp.dev` | Another installation of GenHTTP Lambda. |

## Outputs

| Output | |
|---|---|
| `page_url` | Where the site answers, `https://my-site.genhttp.run/`. |
| `version` | The version of the lambda that is online. |

## `configure`: instead of `actions/configure-pages`

`actions/configure-pages` fails once GitHub Pages is switched off for the
repository. Its drop-in answers with the lambda's address:

```yaml
- id: pages
  uses: Kaliumhexacyanoferrat/genhttp-pages/configure@v1
  with:
    key: ${{ secrets.GENHTTP_KEY }}
- run: hugo --baseURL "${{ steps.pages.outputs.base_url }}/"
```

`base_url`, `origin`, `host` and `base_path` (always empty: a lambda answers at
the root of its address). `static_site_generator` is accepted but not applied -
there is no base path to inject; set static output (Next.js: `output: 'export'`)
in the generator yourself.

## How a site is served

As GitHub Pages serves it:

- `/docs/` answers with `docs/index.html` (or `index.htm`); `/docs` redirects there.
- `/about` answers with `about.html`.
- What is missing answers with the site's `404.html` and status 404.
- `Cache-Control: max-age=600`, `Access-Control-Allow-Origin: *`, an ETag and
  304 for what the client has.
- A project site built for `owner.github.io/repo/` links to `/repo/…`; it is
  served at the root and below `/repo/` (`base_path`).

## A backend beside the site

```yaml
      - uses: Kaliumhexacyanoferrat/genhttp-pages@v1
        with:
          key: ${{ secrets.GENHTTP_KEY }}
          backend: backend
```

```csharp
// backend/lambda.cs - replaces the default "return PagesSite.Create();"
var api = Inline.Create()
                .Get("hello", (string name) => $"Hello, {name}!");

return Layout.Create()
             .Add("api", api)
             .Add(PagesSite.Create());
```

The other files of the folder are compiled beside it. [`website-backend/`](website-backend)
is a real one: it creates the lambdas on [pages.genhttp.run](https://pages.genhttp.run/).
What a lambda can do - secrets, a database, websockets - is in the
[GenHTTP Lambda guide](https://genhttp.dev/docs).

## What is different from GitHub Pages

- **Lifetime.** A free lambda stays online as long as it is used; one that
  nobody visits and nobody deploys to for a month goes offline, and is removed
  two months later. The premium tier keeps it.
- **Size.** 32 MB per deployment on the free tier (GitHub: 1 GB). The action
  checks before it uploads.
- **Domains.** Your own domain comes with the premium tier; a `CNAME` file is
  published like any other.
- **History.** Every deployment is a version in the lambda's editor, to compare
  and put back online. The same site pushed twice is one version.

## How it works

A composite action. It fetches the site (`actions/download-artifact`, or
`actions/checkout` and `actions/jekyll-build-pages`) and runs
[`src/main.mjs`](src/main.mjs) on Node.js, without dependencies, which:

1. reads the lambda with the key (`GET /api/v1/lambdas/{key}`);
2. lays the site out as a lambda version: [`lambda/PagesSite.cs`](lambda/PagesSite.cs)
   to serve it, the files in `resources/site/` - or, where a lambda cannot hold
   their name (spaces, accents, no extension, more than five folders deep,
   names differing only by case), in `resources/blobs/` under their hash - and
   `resources/pages.json` mapping every path to its file;
3. compares it with the newest version, and if nothing changed stops there;
4. uploads it as a zip and puts it online in one call
   (`POST /api/v1/lambdas/{key}/versions/zip?deploy=true`).

The editor key never appears in a log line or an error, and is masked.

## Developing

```bash
node --test 'test/*.test.mjs'                            # unit tests
node test/e2e.mjs https://pages-test.genhttp.run/ site   # checks a published fixture
node tools/check.mjs <key> lambda.cs=lambda/lambda.cs pages/PagesSite.cs=lambda/PagesSite.cs
```

[CI](.github/workflows/ci.yml) publishes the fixtures in `test/fixtures/` with
every mode into a test lambda and checks them as a browser would.

## License

MIT
