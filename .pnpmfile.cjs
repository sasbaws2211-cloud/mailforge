/**
 * drizzle-orm lists mysql2 (and other database drivers) as optional peers. The warehouse connectors depend on mysql2 for
 * MySQL sources, which made pnpm install drizzle-orm a second time in the packages that can see mysql2, with its own
 * copy of every type: two copies of the same library do not type-check against each other. Loomail only uses
 * drizzle-orm with Postgres, so the mysql2 peer is dropped and there is one copy.
 */
function readPackage(pkg) {
  if (pkg.name === "drizzle-orm") {
    for (const field of ["peerDependencies", "peerDependenciesMeta"]) {
      if (pkg[field]) delete pkg[field].mysql2;
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
