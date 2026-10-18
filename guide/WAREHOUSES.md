# Data warehouse sources

If your customer data already lives in **Postgres**, **MySQL**, **SQL Server**, **Snowflake** or **BigQuery**, Loomail can read it on a schedule and turn each row into traits and events. Flows and segments then work on that data with no code on your side.

**Warehouse sources are switched on by the Loomail team, not automatically.** A warehouse can mean a lot of data, so on **Integrate**, under **Data warehouse**, click **Request access** and tell us which database, roughly how much data, and how often it should refresh. We reply by email and set it up with you. Once it is on, the same card lets you connect a warehouse.

Find it on the **Integrate** page, under **Data warehouse**. Redshift, Supabase, Neon, RDS, Aurora and AlloyDB all speak the Postgres protocol, so use the Postgres connector for them. MariaDB, Aurora MySQL, PlanetScale and TiDB speak the MySQL protocol, and Azure SQL Database speaks SQL Server's, so use those connectors for them.

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
| MySQL | `WHERE updated_at >= CAST(:cursor AS DATETIME)` |
| SQL Server | `WHERE updated_at >= CAST(:cursor AS DATETIME2)` |
| Snowflake | `WHERE updated_at >= TO_TIMESTAMP_TZ(:cursor)` |
| BigQuery | `WHERE updated_at >= TIMESTAMP(:cursor)` |

Use `>=`, not `>`. Rows that share the last position value would otherwise be lost. The repeat is harmless: Loomail remembers a fingerprint of the rows at the saved position and skips them when nothing about them changed, and an event's message id is a fingerprint of its row, so a repeat is never recorded twice.

### What the query may and may not do

- One statement, starting with `SELECT` or `WITH`. A trailing semicolon is fine.
- No `$1`, `?` or `@name` parameters, and no dollar-quoted strings. `:cursor` is the only parameter.
- **SQL Server:** a query that starts with `WITH` (a common table expression) is refused, because SQL Server cannot nest one inside the wrapper Loomail adds for ordering and the row cap. Put the `WITH` part in a view, or write it as a subquery in `FROM`. **MySQL:** `/*! ... */` comments are refused, since MySQL runs their contents as SQL.
- The **position column** must be in the query's output, named as a plain column (letters, numbers, underscores). Name it with `AS` if needed.
- Column names in your settings are matched without regard to case. Snowflake upper-cases unquoted names; that is fine.

This check is a guard rail, not the security boundary. **The boundary is the credential**: connect with a user that can only `SELECT`. Postgres and MySQL sources additionally run inside a `READ ONLY` transaction with a statement time limit. SQL Server has no read-only transaction, so for SQL Server the login is the whole guarantee: give it `db_datareader` and nothing else.

## Setting up each warehouse

### Postgres

```sql
CREATE USER loomail_reader WITH PASSWORD '...';
GRANT CONNECT ON DATABASE crm TO loomail_reader;
GRANT USAGE ON SCHEMA public TO loomail_reader;
GRANT SELECT ON users TO loomail_reader;
```

Give Loomail the host, port, database, user and password. Encryption defaults to *encrypted, verify the certificate*. Your database must be reachable from wherever Loomail runs; allow its address in your firewall or security group.

#### Managed Postgres services

The Postgres connector speaks the ordinary Postgres protocol, so it works with the services built on it. What differs is the address, the certificate and the pooler:

| Service | Host and port | Certificate | Notes |
|---|---|---|---|
| **Neon** | `ep-....neon.tech`, 5432. A `-pooler` host is PgBouncer in transaction mode. | Public CA: leave **CA certificate** empty. | Use either host. A scaled-to-zero database takes a few seconds to wake, so the first run after a quiet spell can take longer (it is retried). |
| **Supabase** | The **session pooler** host from *Connect* (port 5432, user `postgres.<project-ref>`) works from any server. The *direct* host `db.<ref>.supabase.co` is **IPv6 only** unless you buy the IPv4 add-on, and many servers have no IPv6. The transaction pooler (port 6543) also works. | Supabase signs with its own CA: paste the **CA certificate** from *Database Settings* into **CA certificate**, keep encryption on *verify*. | Create a read-only role and use that, not `postgres`. |
| **Amazon RDS / Aurora** | The instance or cluster endpoint, port 5432. | Amazon's own CA: paste the [RDS certificate bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) (the whole file) into **CA certificate**, keep *verify*. | Allow Loomail's outgoing address in the security group. The database must be reachable from the internet, or through a VPN or tunnel you provide. IAM authentication is not supported: use a database user. |
| **Amazon Redshift** (provisioned or Serverless) | The cluster or workgroup endpoint, port **5439**. | Issued by AWS Certificate Manager, publicly trusted: leave **CA certificate** empty. | Redshift must be publicly accessible, with Loomail's address allowed. Use a read-only user. If a query starting with `WITH` is refused, put it in a view and select from the view. |

How the connector behaves with them:

- It opens a read-only transaction (`BEGIN READ ONLY`, supported by Redshift too) and sets a statement timeout for it. If a service refuses the timeout setting, the query still runs, still read-only, and the client's own time limit applies.
- The certificate is always checked against the host name exactly as you typed it, including when it is an IP address, and the name is sent for SNI (Neon routes on it).
- Poolers in transaction mode are fine: nothing is kept between transactions.
- "Verify" with a CA you pasted still checks the host name and rejects a certificate that CA did not sign. "Encrypted, do not verify" encrypts but accepts any certificate; use it only to get unstuck.

#### A database that is not on the internet (SSH tunnel)

This works the same for **Postgres, MySQL and SQL Server**: the examples say `5432`, so use `3306` for MySQL and `1433` for SQL Server.

Most production databases sit on a private network. If you have an SSH server that can reach yours (a bastion or jump host), Loomail can connect to *that* and reach the database through it. Only the SSH server has to be reachable from the internet.

```
Loomail  ->  your SSH server (public)  ->  your database (private)
```

In the form, tick **My database is not reachable from the internet** and fill in:

| Field | What to give |
|---|---|
| Database host and port | The database's address **as the SSH server sees it**, such as `db.internal:5432` or `10.0.3.7:5432`. Loomail never resolves or connects to this itself, so a private name is fine. |
| SSH server, port, user | The bastion's address and the account Loomail signs in as. |
| Host key fingerprint | `SHA256:...`, so Loomail only talks to your server and nobody can pose as it. Get it from a machine you trust: `ssh-keyscan -t ed25519 bastion.example.com \| ssh-keygen -lf -` |
| SSH private key (and passphrase) | The private half of a key pair made for Loomail. Stored encrypted, never shown again. |

Set up the SSH side:

```bash
ssh-keygen -t ed25519 -N "" -C "loomail" -f loomail_tunnel
```

Add the **public** half (`loomail_tunnel.pub`) to the SSH user's `~/.ssh/authorized_keys`, with restrictions in front so that the key can do nothing except open a connection to your database:

```
restrict,port-forwarding,permitopen="db.internal:5432" ssh-ed25519 AAAA... loomail
```

Then paste the contents of `loomail_tunnel` (the private half) into Loomail and delete the local copy.

What the SSH server needs:

- `AllowTcpForwarding yes` (or `local`) in `sshd_config`. Some distributions turn it off by default (Alpine does), and when it is off the key cannot override it: you will see *"it could not reach db.internal:5432"* even though the address is right. Remember that OpenSSH uses the **first** value it finds.
- A firewall rule letting Loomail's outgoing address reach the SSH port. A hosted Loomail refuses an SSH server on a private or local address (it must be reachable from the internet); the database behind it may be private.
- Key authentication. Loomail never offers a password over SSH.

How it stays safe:

- The SSH server's host key is **pinned**: a server with any other key is refused, and the message tells you the fingerprint it saw.
- Each query opens its own tunnel, uses it for exactly one connection on `127.0.0.1`, and closes it afterwards, also when the query fails.
- The database credential is checked and used exactly as without a tunnel: read-only transaction, time limit, row cap. The database's own TLS certificate is still verified against the host name you typed.
- Editing a source keeps what you do not retype: changing the password keeps the SSH key, and changing the key keeps the password. Turning the tunnel off deletes the saved key.

| Message | Cause |
|---|---|
| *The SSH server's host key is not the one you pinned. It is SHA256:...* | The server was rebuilt or replaced, or someone is intercepting the connection. If you expected the change, paste the new fingerprint. |
| *The SSH server refused the key for user ...* | Wrong user, the public key is not in that user's `authorized_keys`, or the passphrase is wrong. |
| *The SSH private key could not be read* | Not the whole key (include the BEGIN and END lines), or the passphrase is missing or wrong. |
| *Connected to the SSH server, but it could not reach db.internal:5432* | The database host or port is wrong as the SSH server sees it, forwarding is disabled in `sshd_config`, or `permitopen` in `authorized_keys` does not list that exact host and port. |
| *Could not connect to the SSH server* / *did not answer in time* | The SSH server's address or port, or a firewall. These are retried on the next run. |
| *Could not connect to the database: password authentication failed* | The tunnel is fine; the database user or password is wrong. |

SSH tunnels are for the connectors that dial a host and port: Postgres, MySQL and SQL Server (including RDS and Aurora in a private subnet). Snowflake and BigQuery are cloud services reached over HTTPS and need none.

Tunnel notes for MySQL and SQL Server:

- The database host name you give is used for certificate checking even though the traffic goes through the tunnel, so a private name such as `db.internal` needs a certificate for that name, or the CA pasted in, or *do not verify*.
- **Azure SQL** may redirect a client to a different gateway address; behind a tunnel that redirect cannot be followed. Use the *Proxy* connection policy for the server, or the *Redirect* policy only without a tunnel.
- Messages are the same as above; a wrong host or port as the SSH server sees it reads *it could not reach db.internal:3306* (or `:1433`).

### MySQL

Works with MySQL 5.7+ and 8.x, MariaDB, Amazon Aurora MySQL, PlanetScale and TiDB.

```sql
CREATE USER 'loomail_reader'@'%' IDENTIFIED BY '...';
GRANT SELECT ON crm.users TO 'loomail_reader'@'%';
```

Give Loomail the host, port (3306), database, user and password. Encryption defaults to *encrypted, verify the certificate*; for Amazon RDS / Aurora paste the [RDS certificate bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) as the CA certificate.

- Each run is one prepared statement inside a `START TRANSACTION READ ONLY`, with `max_execution_time` (MySQL) or `max_statement_time` (MariaDB) set to the time limit when the server has them.
- `DATETIME` columns carry no time zone; Loomail reads them as UTC. Keep the position column in UTC, or convert it in the query (`CONVERT_TZ(updated_at, 'Europe/London', '+00:00') AS updated_at`).
- `DECIMAL` values arrive as numbers, `JSON` columns as text, and binary columns as base64 text.
- With the *verify* setting, the server certificate is checked against the host name you typed.

### SQL Server

Works with SQL Server 2016+ and Azure SQL Database / Managed Instance.

```sql
CREATE LOGIN loomail_reader WITH PASSWORD = '...';
USE crm;
CREATE USER loomail_reader FOR LOGIN loomail_reader;
ALTER ROLE db_datareader ADD MEMBER loomail_reader;
```

Give Loomail the host, **port** (1433 unless you changed it), database, user and password (SQL Server authentication; Windows/Entra sign-in is not supported). Use a port, not an instance name: named instances are found over UDP, which cannot go through a tunnel or most firewalls. For a named instance, find its fixed TCP port in SQL Server Configuration Manager and give that.

- Loomail declares read-only intent and applies the time limit, but SQL Server cannot enforce a read-only transaction. **Use a login that can only read.**
- Encryption is on by default and the certificate is verified. A self-hosted SQL Server often has a self-signed certificate: either paste its CA as the CA certificate, or choose *encrypted, do not verify*. Azure SQL uses a public CA and needs nothing.
- Timestamps (`datetime2`, `datetime`) are read as UTC. `decimal`/`money` values arrive as numbers and `uniqueidentifier` as text.
- Cast `:cursor` explicitly: `CAST(:cursor AS DATETIME2)`.

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
| SSH tunnel | Optional, Postgres, MySQL and SQL Server: reach a private database through an SSH server. See above. |
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

Warehouse sources are **off for every workspace** until a platform admin switches them on (admin console, open the workspace, **Warehouse sources**, with a reason that goes in the audit log). Customers ask through Support from the Data warehouse card; the request says the database, rough size and refresh rate, which is what you need to decide on pricing or a dedicated database. Switching it off stops that workspace's sources syncing and blocks creating, testing, syncing or editing; nothing is deleted, and the customer can still see, pause and delete what they have. Workspaces that already had a warehouse source when this was introduced were switched on by the migration.

| Variable | Default | Purpose |
|---|---|---|
| `LOOMAIL_RESTRICT_WAREHOUSE_HOSTS` | on for a hosted service, off otherwise | When on, a database host that resolves to a loopback, private, link-local or reserved address is refused (the same protection as SMTP and webhooks), and the connection goes to the address that was checked. |
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
