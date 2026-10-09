// Passes the assistant's requests on to the API of GenHTTP Lambda.
//
// Nothing is kept here: the editor key of a new lambda goes back to the
// browser that asked for it and is neither logged nor stored.

using System.Net.Http;
using System.Net.Http.Json;

public record NewLambda(string PublicKey, bool AcceptedTerms);

public record KeyAnswer(string PublicKey, bool Valid, bool Available, string Reason, string Address);

public record CreatedLambda(string PublicKey, string PrivateKey, string Address, string Editor);

public static class Platform
{
    private const string Server = "https://genhttp.dev";

    private static readonly HttpClient Client = new()
    {
        BaseAddress = new Uri(Server + "/api/v1/"),
        Timeout = TimeSpan.FromSeconds(30),
        DefaultRequestHeaders = { { "User-Agent", "genhttp-pages-assistant" } }
    };

    public static async Task<KeyAnswer> CheckAsync(string key)
    {
        var wanted = (key ?? string.Empty).Trim().ToLowerInvariant();

        using var response = await Client.GetAsync("keys/" + Uri.EscapeDataString(wanted));

        var answer = await Read(response);

        var publicKey = answer.TryGetProperty("publicKey", out var k) ? k.GetString() : wanted;

        return new KeyAnswer(
            publicKey,
            answer.TryGetProperty("valid", out var valid) && valid.GetBoolean(),
            answer.TryGetProperty("available", out var available) && available.GetBoolean(),
            answer.TryGetProperty("reason", out var reason) ? reason.GetString() : null,
            $"https://{publicKey}.genhttp.run/");
    }

    public static async Task<CreatedLambda> CreateAsync(NewLambda request)
    {
        if (request is null || !request.AcceptedTerms)
        {
            throw new ProviderException(ResponseStatus.BadRequest, "Accept the terms of GenHTTP Lambda to create a lambda.");
        }

        var body = new Dictionary<string, object>
        {
            ["publicKey"] = string.IsNullOrWhiteSpace(request.PublicKey) ? null : request.PublicKey.Trim().ToLowerInvariant(),
            ["acceptedTerms"] = true,
            ["view"] = "Full"
        };

        using var response = await Client.PostAsJsonAsync("lambdas", body);

        var created = await Read(response);

        var privateKey = Text(created, "privateKey");

        return new CreatedLambda(Text(created, "publicKey"), privateKey, Text(created, "address"), Server + "/editor/" + privateKey);
    }

    private static string Text(JsonElement json, string name)
        => json.TryGetProperty(name, out var value) ? value.GetString() : null;

    /// <summary>
    /// The answer of the platform, or its complaint as ours.
    /// </summary>
    private static async Task<JsonElement> Read(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync();

        JsonElement json;

        try
        {
            json = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text).RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new ProviderException(ResponseStatus.BadGateway, "GenHTTP Lambda answered with something that is not JSON. Try again in a moment.");
        }

        if (!response.IsSuccessStatusCode)
        {
            var message = json.ValueKind == JsonValueKind.Object && json.TryGetProperty("message", out var m) ? m.GetString() : response.ReasonPhrase;

            var status = (int)response.StatusCode is >= 400 and < 500 ? (ResponseStatus)(int)response.StatusCode : ResponseStatus.BadGateway;

            throw new ProviderException(status, message ?? "GenHTTP Lambda refused the request.");
        }

        return json;
    }
}
