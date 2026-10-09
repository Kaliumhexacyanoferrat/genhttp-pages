# GenHTTP Pages

Publish your GitHub Pages site to [GenHTTP Lambda](https://genhttp.dev/) instead.
A drop-in replacement for `actions/deploy-pages`: keep your workflow and change
the step that deploys. No secret, no account.

```diff
     steps:
       - id: deployment
-        uses: actions/deploy-pages@v5
+        uses: Kaliumhexacyanoferrat/genhttp-pages@v1
+        with:
+          activation: gp-xxxxx-xxxxx-xxxxx-xxxxx
```

**[pages.genhttp.run](https://pages.genhttp.run/)** activates your repository:
it makes the lambda that hosts your site, hands you the link to its editor and
the activation code, and rewrites your workflow. That page is published by this
action, from this repository, without a secret ([`docs.yml`](.github/workflows/docs.yml)).

## Why not just GitHub Pages?

The same files, served the same way, plus an editor for the site:

- **Traffic statistics** counted on the server - no script, no cookie.
- **A request log** with what failed, what your code printed and its errors.
- **Every deployment a version**, one click to put an older one back.
- **An API by asking for it**: a form that stores what it is sent, a proxy
  that keeps a key from the browser, a database, websockets - the editor's
  agent, or yours through MCP, writes it beside the site, and pushes keep it
  ([more](#a-backend-beside-the-site)).
- **Previews** of pull requests (`preview: true`).

GitHub is ahead on size (1 GB against 32 MB on the free tier), on free custom
domains, and on keeping an unvisited site forever - see
[what is different](#what-is-different-from-github-pages).

## Getting started

1. **Activate the repository** at [pages.genhttp.run](https://pages.genhttp.run/#setup).
   Keep the editor link it gives you: it is shown once and is the only way into
   the editor.
2. **Change the workflow** as above, with your activation code. Your build,
   `actions/upload-pages-artifact`, the `github-pages` environment and the
   permissions stay as they are - the job needs `id-token: write`, which Pages
   workflows have.
3. **Push.** The run publishes to `https://my-site.genhttp.run/` and links it,
   as `page_url`, from its summary.

### How activation works

The first run that presents the code, with the GitHub OIDC token of a run of
the repository it was made for, binds the code to that repository's id (which
outlives renames). From then on the action asks GitHub for the run's token and
[pages.genhttp.run](website-backend/Activations.cs) hands it the editor key of
the lambda to publish to.

- Only someone who can change the repository's workflows gets the code into a
  run of it, so nobody can activate a repository that is not theirs. A code
  that was used is bound, and gives nothing to whoever reads it in a public
  workflow.
- A repository with one site may drop the code after the first run; with
  several, each workflow keeps its code to say which site it publishes.
- Editor keys are kept sealed under a secret of the broker, codes only as
  hashes. Runs of forks get no token.

### With a secret instead

The editor link ends with the editor key. Store it as the repository secret
`GENHTTP_KEY` and pass `key: ${{ secrets.GENHTTP_KEY }}` instead of
`activation`. Without either, the run fails and its summary says what to do.

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

permissions:
  contents: read
  id-token: write   # to be recognised by the activation

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: Kaliumhexacyanoferrat/genhttp-pages@v1
        with:
          activation: gp-xxxxx-xxxxx-xxxxx-xxxxx
          branch: gh-pages
          folder: /            # or /docs
```

Jekyll runs in `actions/jekyll-build-pages`, as on GitHub, so it needs a Linux
runner.

### A folder

No artifact needed (the job needs `id-token: write` as above):

```yaml
      - uses: actions/checkout@v7
      - run: npm ci && npm run build
      - uses: Kaliumhexacyanoferrat/genhttp-pages@v1
        with:
          activation: gp-xxxxx-xxxxx-xxxxx-xxxxx
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
| `activation` | | The code the assistant gave for this repository. Needed for the first run; after that, a run is recognised by its OIDC token. Keep it where a repository has several sites. |
| `key` | | Instead of an activation: the lambda's editor key, from a secret. Left out, `$GENHTTP_KEY` is read. |
| `path` | | Publish this folder instead of an artifact. |
| `branch` | | Publish this branch. |
| `folder` | `/` | With `branch`: the folder to publish. |
| `jekyll` | `auto` | With `branch`: `auto` builds unless there is a `.nojekyll`, `true` always, `false` never. |
| `include_hidden_files` | `false` | With `path` or `branch`: publish dot files (`.well-known/`). An artifact holds what its upload included. |
| `base_path` | `auto` | Also serve the site below these folders. `auto`: below `/<repository>/` for a project site, which is what it was built for; nothing for a user site or one with a `CNAME`. `none`, or paths separated by commas. |
| `backend` | | A folder of C# to publish beside the site (see below). |
| `server` | `https://genhttp.dev` | Another installation of GenHTTP Lambda. |
| `broker` | `https://pages.genhttp.run` | Where activations are kept and tokens exchanged for the key. |

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
    activation: gp-xxxxx-xxxxx-xxxxx-xxxxx
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

A lambda runs code beside the site, on the same address, so the pages call it
with `fetch('api/…')`: a form that stores what it is sent, a counter, a proxy
that keeps an API key from the browser, something live.

**Ask for it.** GenHTTP Lambda is built to be changed by agents. In the
lambda's editor, under **Change**, say what you need - *"Add an API at
api/signups that stores the e-mail addresses my newsletter form posts"* - and
its agent writes the routes, switches on a database if they need one, tries
them in a draft and puts them online. Or use your own agent through MCP and
give it the editor link:

```bash
claude mcp add --transport http genhttp https://genhttp.dev/mcp
```

**A push keeps it.** The action replaces what the site owns -
`resources/site/`, `resources/blobs/`, `resources/pages.json`,
`pages/PagesSite.cs` and `docs/pages.md` - and keeps everything else of the
newest version: the routes, `resources/migrations/`, the documentation. The
database is never touched by a deployment. `docs/pages.md` tells the next agent
which files come from GitHub. Routes go in front of the site in `lambda.cs`; a
`lambda.cs` without `PagesSite.Create()` is replaced by the next push:

```csharp
return Layout.Create()
             .Add("api", api)
             .Add(PagesSite.Create());
```

A form or a button that uses the API belongs to the site, so it is changed in
the repository.

**Or keep it in the repository**, with `backend`: its `lambda.cs` replaces the
lambda's, its other files go to `backend/`, its `resources/` (migrations, say)
become the lambda's - all replaced on every push.

```yaml
      - uses: Kaliumhexacyanoferrat/genhttp-pages@v1
        with:
          activation: gp-xxxxx-xxxxx-xxxxx-xxxxx
          backend: backend
```

[`website-backend/`](website-backend) is a real one: it activates repositories
for [pages.genhttp.run](https://pages.genhttp.run/). What a lambda can do -
secrets, a database, websockets - is in the [GenHTTP Lambda guide](https://genhttp.dev/docs).

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

1. finds the editor key: the `key` input, or the run's GitHub OIDC token
   exchanged at `https://pages.genhttp.run/api/oidc/key` ([`src/credentials.mjs`](src/credentials.mjs));
2. reads the lambda with the key (`GET /api/v1/lambdas/{key}`);
3. lays the site out as a lambda version: [`lambda/PagesSite.cs`](lambda/PagesSite.cs)
   to serve it, the files in `resources/site/` - or, where a lambda cannot hold
   their name (spaces, accents, no extension, deeply nested, names differing
   only by case), in `resources/blobs/` under their hash - and
   `resources/pages.json` mapping every path to its file;
4. reads the newest version, swaps what the site owns and keeps the rest - what
   an agent or a person added in the editor - and if that changes nothing, stops there;
5. uploads it as a zip and puts it online in one call
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
