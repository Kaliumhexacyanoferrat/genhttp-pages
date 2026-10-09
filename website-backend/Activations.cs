// Repositories activated for GenHTTP Pages, so their workflows publish
// without a secret.
//
// Activating a repository (the assistant) makes a lambda - or takes one the
// person already has - and hands them its editor link and an activation code.
// The code goes into their workflow once. The first run that presents it,
// with a GitHub OIDC token of the repository it was made for, binds it to that
// repository's GitHub id. From then on a token of that repository is enough
// to be handed the editor key, which is how the action publishes.
//
// Why a code: activating by name alone would let anybody activate somebody
// else's repository first and keep the editor link of the lambda it then
// publishes to. Only whoever can change the repository's workflows gets the
// code into a run of it, and only runs of that repository get its tokens. A
// code that was used is bound to the repository's id, so it gives nothing to
// whoever reads it in a public workflow afterwards.

using System.Security.Cryptography;

public record ActivationRequest(string Repository, string PublicKey, bool AcceptedTerms, string PrivateKey);

public record Activated(string Repository, string PublicKey, string Address, string Editor, string Activation);

public record ExchangeRequest(string Token, string Activation);

public record Grant(string PrivateKey, string PublicKey, string Address, string Repository);

public static class Activations
{
    /// <summary>How long a code that was never used stays usable.</summary>
    private static readonly TimeSpan Pending = TimeSpan.FromDays(30);

    private const string Alphabet = "abcdefghjkmnpqrstuvwxyz23456789";

    public static async Task<Activated> ActivateAsync(ActivationRequest request)
    {
        var repository = Repository(request?.Repository);

        string privateKey;
        string publicKey;
        string address;

        if (!string.IsNullOrWhiteSpace(request.PrivateKey))
        {
            // a lambda of their own, which the key proves
            var lambda = await Platform.ReadAsync(request.PrivateKey.Trim());

            (privateKey, publicKey, address) = (request.PrivateKey.Trim(), lambda.PublicKey, lambda.Address);
        }
        else
        {
            var lambda = await Platform.CreateAsync(new NewLambda(request.PublicKey, request.AcceptedTerms));

            (privateKey, publicKey, address) = (lambda.PrivateKey, lambda.PublicKey, lambda.Address);
        }

        var code = NewCode();

        using (var connection = Database.GetConnection())
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                INSERT INTO activations (repository, code_hash, public_key, sealed_key, created)
                VALUES ($repository, $hash, $publicKey, $sealed, $created)
                """;

            command.Parameters.AddWithValue("$repository", repository);
            command.Parameters.AddWithValue("$hash", Hash(code));
            command.Parameters.AddWithValue("$publicKey", publicKey);
            command.Parameters.AddWithValue("$sealed", Seal(privateKey, publicKey));
            command.Parameters.AddWithValue("$created", Now());

            command.ExecuteNonQuery();
        }

        Console.WriteLine($"Activated {repository} for lambda {publicKey}");

        return new Activated(repository, publicKey, address, Platform.EditorOf(privateKey), code);
    }

    public static async Task<Grant> ExchangeAsync(ExchangeRequest request)
    {
        var run = await GitHubTokens.VerifyAsync(request?.Token);

        var code = request.Activation?.Trim().ToLowerInvariant();

        using var connection = Database.GetConnection();

        Row row;

        if (!string.IsNullOrEmpty(code))
        {
            row = Find(connection, "code_hash = $hash", ("$hash", Hash(code)));

            if (row == null)
            {
                throw Refused($"The activation code is not known. Activate {run.Repository} at {Site}#setup and use the code it gives you.");
            }

            if (row.RepositoryId == null)
            {
                // its first use: by a run of the repository it was made for, in time
                if (!string.Equals(row.Repository, run.Repository, StringComparison.OrdinalIgnoreCase))
                {
                    throw Refused($"The activation code was made for {row.Repository}, not for {run.Repository}.");
                }

                if (DateTime.UtcNow - DateTime.Parse(row.Created).ToUniversalTime() > Pending)
                {
                    throw Refused($"The activation code was never used and has expired. Activate {run.Repository} again at {Site}#setup.");
                }

                Bind(connection, row.Id, run);

                Console.WriteLine($"Bound {run.Repository} to lambda {row.PublicKey}");
            }
            else if (row.RepositoryId != run.RepositoryId)
            {
                throw Refused("The activation code belongs to another repository.");
            }
        }
        else
        {
            // the lambda the repository was bound to last
            row = Find(connection, "repository_id = $id AND owner_id = $owner ORDER BY bound DESC", ("$id", run.RepositoryId), ("$owner", run.OwnerId));

            if (row == null)
            {
                throw Refused($"{run.Repository} is not activated for GenHTTP Pages. Activate it at {Site}#setup and add the activation code to the workflow.");
            }
        }

        Touch(connection, row.Id);

        return new Grant(Open(row.Sealed, row.PublicKey), row.PublicKey, $"https://{row.PublicKey}.genhttp.run/", run.Repository);
    }

    #region Storage

    private sealed record Row(long Id, string Repository, string PublicKey, string Sealed, string Created, string RepositoryId);

    private static Row Find(SqliteConnection connection, string where, params (string Name, string Value)[] values)
    {
        using var command = connection.CreateCommand();

        command.CommandText = $"SELECT id, repository, public_key, sealed_key, created, repository_id FROM activations WHERE {where} LIMIT 1";

        foreach (var (name, value) in values)
        {
            command.Parameters.AddWithValue(name, value);
        }

        using var reader = command.ExecuteReader();

        if (!reader.Read())
        {
            return null;
        }

        return new Row(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4),
                       reader.IsDBNull(5) ? null : reader.GetString(5));
    }

    private static void Bind(SqliteConnection connection, long id, GitHubRun run)
    {
        using var command = connection.CreateCommand();

        command.CommandText = "UPDATE activations SET repository_id = $id, owner_id = $owner, bound = $now WHERE id = $row AND repository_id IS NULL";

        command.Parameters.AddWithValue("$id", run.RepositoryId);
        command.Parameters.AddWithValue("$owner", run.OwnerId);
        command.Parameters.AddWithValue("$now", Now());
        command.Parameters.AddWithValue("$row", id);

        command.ExecuteNonQuery();
    }

    private static void Touch(SqliteConnection connection, long id)
    {
        using var command = connection.CreateCommand();

        command.CommandText = "UPDATE activations SET used = $now WHERE id = $row";

        command.Parameters.AddWithValue("$now", Now());
        command.Parameters.AddWithValue("$row", id);

        command.ExecuteNonQuery();
    }

    #endregion

    #region Codes and keys

    private const string Site = "https://pages.genhttp.run/";

    private static string Now() => DateTime.UtcNow.ToString("O");

    /// <summary>"owner/name", checked and in lower case, as GitHub compares them.</summary>
    private static string Repository(string value)
    {
        var repository = (value ?? string.Empty).Trim().ToLowerInvariant();

        if (repository.StartsWith("https://github.com/"))
        {
            repository = repository["https://github.com/".Length..].TrimEnd('/');
        }

        var parts = repository.Split('/');

        if (parts.Length != 2 || parts.Any(p => p.Length == 0 || p.Length > 100 || !p.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.')))
        {
            throw new ProviderException(ResponseStatus.BadRequest, "Name the repository as owner/name, as in github.com/owner/name.");
        }

        return repository;
    }

    /// <summary>gp- and 20 letters and digits that cannot be mistaken for one another: 98 bits.</summary>
    private static string NewCode()
    {
        var builder = new StringBuilder("gp-");

        for (var i = 0; i < 20; i++)
        {
            if (i > 0 && i % 5 == 0)
            {
                builder.Append('-');
            }

            builder.Append(Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)]);
        }

        return builder.ToString();
    }

    private static string Hash(string code)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(code.Trim().ToLowerInvariant()))).ToLowerInvariant();

    private static byte[] SealKey() => SHA256.HashData(Encoding.UTF8.GetBytes(Secret.Read("PAGES_SEAL_KEY")));

    /// <summary>The editor key, sealed for the database, bound to the lambda it opens.</summary>
    private static string Seal(string privateKey, string publicKey)
    {
        var plain = Encoding.UTF8.GetBytes(privateKey);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var sealedBytes = new byte[plain.Length];
        var tag = new byte[16];

        using (var aes = new AesGcm(SealKey(), 16))
        {
            aes.Encrypt(nonce, plain, sealedBytes, tag, Encoding.UTF8.GetBytes(publicKey));
        }

        return Convert.ToBase64String([.. nonce, .. tag, .. sealedBytes]);
    }

    private static string Open(string sealedText, string publicKey)
    {
        var bytes = Convert.FromBase64String(sealedText);
        var plain = new byte[bytes.Length - 28];

        using (var aes = new AesGcm(SealKey(), 16))
        {
            aes.Decrypt(bytes.AsSpan(0, 12), bytes.AsSpan(28), bytes.AsSpan(12, 16), plain, Encoding.UTF8.GetBytes(publicKey));
        }

        return Encoding.UTF8.GetString(plain);
    }

    private static ProviderException Refused(string message) => new(ResponseStatus.Forbidden, message);

    #endregion
}
