// The documentation of GenHTTP Pages, with the two calls its setup assistant
// makes. The page cannot call the GenHTTP Lambda API itself - the API does not
// answer other origins - so these pass its requests on, server to server.
//
//   GET  api/keys/{key}   whether an address is free
//   POST api/lambdas      { "publicKey": "...", "acceptedTerms": true } -> a new lambda and its editor key
//   anything else         the site, served as GitHub Pages would (PagesSite)
//
// Deployed by this repository's own workflow with the GenHTTP Pages action and
// its 'backend' input: change it in the repository, not in the editor.

var api = Inline.Create()
                .Get("keys/:key", (string key) => Platform.CheckAsync(key))
                .Post("lambdas", (NewLambda request) => Platform.CreateAsync(request));

return Layout.Create()
             .Add("api", api)
             .Add(PagesSite.Create());
