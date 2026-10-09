// The documentation of GenHTTP Pages, and the services its assistant and the
// action call. The page cannot call the GenHTTP Lambda API itself - it does
// not answer other origins - so the first two pass requests on.
//
//   GET  api/keys/{key}     whether an address is free
//   POST api/lambdas        a new lambda and its editor key
//   POST api/activations    activates a repository: a lambda (new, or one whose key is given),
//                           its editor link and an activation code for the workflow
//   POST api/oidc/key       { token, activation } -> the editor key of the lambda the
//                           repository the GitHub OIDC token is from was activated for
//   anything else           the site, served as GitHub Pages would (PagesSite)
//
// Deployed by this repository's own workflow with the GenHTTP Pages action and
// its 'backend' input: change it in the repository, not in the editor.

using (var connection = Database.GetConnection())
{
    var evolve = new Evolve(connection, message => Console.WriteLine(message))
    {
        Locations = [Resources.Root + "migrations"],
        IsEraseDisabled = true
    };

    evolve.Migrate();
}

var api = Inline.Create()
                .Get("keys/:key", (string key) => Platform.CheckAsync(key))
                .Post("lambdas", (NewLambda request) => Platform.CreateAsync(request))
                .Post("activations", (ActivationRequest request) => Activations.ActivateAsync(request))
                .Post("oidc/key", (ExchangeRequest request) => Activations.ExchangeAsync(request));

return Layout.Create()
             .Add("api", api)
             .Add(PagesSite.Create());
