-- A repository activated for GenHTTP Pages, and the lambda it publishes to.
--
-- Made by the assistant with a code only the person activating knows, and
-- bound to the GitHub id of the repository by the first workflow run that
-- presents the code with an OIDC token of that repository. Neither the code
-- nor the editor key is kept as it is: the code as its hash, the key sealed
-- under a secret of this lambda.
CREATE TABLE activations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repository    TEXT NOT NULL,        -- owner/name as activated, in lower case
    code_hash     TEXT NOT NULL UNIQUE, -- SHA-256 of the activation code, hex
    public_key    TEXT NOT NULL,        -- the address of the lambda
    sealed_key    TEXT NOT NULL,        -- its editor key, AES-GCM under PAGES_SEAL_KEY
    created       TEXT NOT NULL,
    repository_id TEXT,                 -- GitHub's id of the repository, once bound
    owner_id      TEXT,
    bound         TEXT,
    used          TEXT
);

CREATE INDEX activations_by_repository ON activations (repository_id, bound);
