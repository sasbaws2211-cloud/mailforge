# Data warehouse sources

If your customer data already lives in **Postgres**, **Snowflake** or **BigQuery**, Loomail can read it on a schedule and turn each row into traits and events. Flows and segments then work on that data with no code on your side.

Find it on the **Integrate** page, under **Data warehouse**. Redshift, Supabase, Neon, RDS, Aurora and AlloyDB all speak the Postgres protocol, so use the Postgres connector for them.

This is the opposite of [inbound webhooks](INGESTION.md): there, another system pushes to Loomail; here, Loomail pulls.

## How it works

1. You write **one SELECT**.
2. Every N minutes Loomail runs it, asking only for rows at or after where the last run got to.
3. Each row becomes an `identify` (traits) and, if you named one, a `track` (an event), through the same code as the HTTP API. Plan limits, email-conflict handling and lifecycle rules all apply.
4. Loomail remembers the highest value of your **position column** and starts there next time.

Loomail wraps your query like this, so you do not write `ORDER BY` or `LIMIT`:

```sql
SELECT * FROM (<your query>) AS loomail_q ORDER BY <position column> ASC LIMIT <batch size>
```

### The one parameter: `:cursor`

`:cursor` is the saved position, always passed as a bound value (never pasted into the text). It arrives as text, so cast it:

| Warehouse | Example |
|---|---|
| Postgres | `WHERE updated_at >= :cursor::timestamptz` |
| Snowflake | `WHERE updated_at >= TO_TIMESTAMP_TZ(:cursor)` |
| BigQuery | `WHERE updated_at >= TIMESTAMP(:cursor)` |

Use `>=`, not `>`. Rows that share the last position value would otherwise be lost. The repeat is harmless: Loomail remembers a fingerprint of the rows at the saved position and skips them when nothing about them changed, and an event's message id is a fingerprint of its row, so a repeat is never recorded twice.

### What the query may and may not do

- One statement, starting with `SELECT` or `WITH`. A trailing semicolon is fine.
- No `$1`, `?` or `@name` parameters, and no dollar-quoted strings. `:cursor` is the only parameter.
- The **position column** must be in the query's output, named as a plain column (letters, numbers, underscores). Name it with `AS` if needed.
- Column names in your settings are matched without regard to case. Snowflake upper-cases unquoted names; that is fine.

This check is a guard rail, not the security boundary. **The boundary is the credential**: connect with a user that can only `SELECT`. Postgres sources additionally run inside a `READ ONLY` transaction with a statement timeout.

## Setting up each warehouse

### Postgres

```sql
CREATE USER loomail_reader WITH PASSWORD '...';
GRANT CONNECT ON DATABASE crm TO loomail_reader;
GRANT USAGE ON SCHEMA public TO loomail_reader;
GRANT SELECT ON users TO loomail_reader;
```

Give Loomail the host, port, database, user and password. Encryption defaults to *encrypted, verify the certificate*. Your database must be reachable from wherever Loomail runs; allow its address in your firewall or security group.

### Snowflake

Loomail uses Snowflake's SQL API with **key-pair sign-in** (no password is stored).

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out loomail_key.p8 -nocrypt
openssl rsa -in loomail_key.p8 -pubout -out loomail_key.pub
```

```sql
CREATE ROLE loomail_reader;
GRANT USAGE ON WAREHOUSE compute_wh TO ROLE loomail_reader;
GRANT USAGE ON DATABASE analytics TO ROLE loomail_reader;
GRANT USAGE ON SCHEMA analytics.public TO ROLE loomail_reader;
GRANT SELECT ON TABLE analytics.public.users TO ROLE loomail_reader;
CREATE USER loomail_svc DEFAULT_ROLE = loomail_reader RSA_PUBLIC_KEY = '<contents of loomail_key.pub without the BEGIN/END lines>';
GRANT ROLE loomail_reader TO USER loomail_svc;
```

In Loomail enter the **account identifier** (`myorg-myaccount`, or a locator such as `xy12345.eu-west-1`), the user, the compute warehouse and role, and paste the contents of `loomail_key.p8`. If your key is encrypted, add its passphrase. If Snowflake answers 401, the public key on the user does not match the private key you pasted, or the account identifier is wrong. Check with `DESC USER loomail_svc` (the `RSA_PUBLIC_KEY_FP` field).

If your account uses a network policy, allow your Loomail server's outgoing address.

### BigQuery

1. Create a **service account** in your Google Cloud project.
2. Give it **BigQuery Job User** on the project and **BigQuery Data Viewer** on the dataset.
3. Create a JSON key for it and paste the whole file into Loomail.

Set the **location** if your dataset is not in the default US/EU multi-region (for example `europe-west2`), and the **data limit per query**: every query carries `maximumBytesBilled`, so a mistake fails instead of running up a bill (default 10 GB).

## The settings

| Setting | Meaning |
|---|---|
| Position column / type | The column that rises when a row is added or changed (`updated_at`), and whether it holds a date and time, a number or text. |
| Start from | Optional first position. Empty reads everything the first time. |
| Run every | 5 to 1440 minutes. After a failure the next try comes sooner (at most 15 minutes). |
| Rows per batch | 10 to 5000. A run reads up to 5 batches, then carries on next time. |
| User id / email column | Who the row is about. One is enough; with only an email, people are matched by it. A row with neither is skipped, not an error. |
| Event | A fixed name, a name read from a column, or none (traits only). |
| Time column | Optional. Events more than 3 days from the present are recorded at sync time (the same rule as the HTTP API). |
| Traits | Trait name to column. A `null` value is skipped, never used to clear a trait. |
| Keep the row's values on the event | The row's non-null columns become the event's properties. |

**Test the query** shows the first rows and what each would become, and records nothing. Use it before saving.

**Sync now** runs a source at once and shows the result. **Read everything again** resets the position; nothing already recorded is doubled.

## Things worth knowing

- **One run at a time per source**, enforced with a lease, so it is safe with several servers. A crashed run's lease expires by itself.
- **The position only moves after every row in a batch was handled.** A failure (warehouse down, plan limit reached) leaves it where it was; the next run starts from there and loses nothing.
- **Plan limit reached:** the run stops and says so. It continues from the same place once there is room.
- **More rows share one position value than fit in a batch:** Loomail cannot move past them and says so. Raise the batch size.
- **Deleted rows** in the warehouse are not noticed; Loomail only sees rows that exist. Use a status column and a trait if you need to react to removals.
- **Credentials** are stored encrypted with `ENCRYPTION_KEY` and never returned by the API. A warehouse source cannot be created on an install without `ENCRYPTION_KEY`.
- **Export and deletion:** sources are included in the workspace export (without credentials) and are erased with the workspace.
- A workspace can have up to 5 warehouse sources. Only an owner can add, change or run one.

## For the operator

| Variable | Default | Purpose |
|---|---|---|
| `LOOMAIL_RESTRICT_WAREHOUSE_HOSTS` | on for a hosted service, off otherwise | When on, a Postgres host that resolves to a loopback, private, link-local or reserved address is refused (the same protection as SMTP and webhooks), and the connection goes to the address that was checked. |
| `LOOMAIL_WAREHOUSE_ALLOWED_HOSTS` | none | Comma-separated hosts that skip the check, for a database on your own network. |

Snowflake and BigQuery addresses are built by Loomail from the account name or the fixed Google addresses, so customers never supply a host for them. For BigQuery, the token address inside the key file is ignored on purpose.

Your outgoing address must be allowed by the customer's firewall, so tell customers which IP Loomail connects from.

## Troubleshooting

| Message | Cause |
|---|---|
| *The query does not return these columns: ...* | A column named in the settings is not in the query's output. The message lists what it does return. |
| *Could not connect to the database* | Host, port, firewall, or password. Postgres errors show the driver's reason. |
| *Snowflake refused the sign-in (401)* | Public key not set on the user, wrong account identifier, or the wrong key pasted. |
| *Google refused the service account* | Key file wrong or revoked. |
| *Query exceeded limit for bytes billed* | The query would read more than the data limit. Narrow the query (filter on a partition column) or raise the limit. |
| *The query took too long* | A batch has 60 seconds. Make the query faster: filter on an indexed or partitioned column. |
| *More than N rows share the same ... value* | Raise the batch size. |
| *Your plan's contact limit is reached* | New people cannot be created until there is room. |
