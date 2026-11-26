# Main branch reconciliation

After a production promotion from `development` to `main`, reconcile the promoted history back into `development` before starting the next release.

1. Create a `reconcile/*` branch from the current `main` commit.
2. Open a pull request targeting `development`.
3. Include a non-empty `## Main reconciliation` section explaining which promotion is being brought back and why.
4. Obtain the required review and a successful `quality` check.
5. Merge the reconciliation pull request using the repository's normal merge method.
6. Verify that `main` is an ancestor of `development` before the next release.

Reconciliation must not bypass branch protection or alter production code merely to align history.
