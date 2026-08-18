# Operations reference

The extension registers one tool, `graphite`. Its parameters are a closed union: the `operation`
field picks a variant, and each variant accepts only its own fields. Unknown operations, unknown
fields, and missing fields are rejected before any command runs.

## Inspection

| Field | Type |
| --- | --- |
| `operation` | `"inspect"` |
| `target` | `"stack"`, `"stack_short"`, `"state"`, `"parent"`, `"children"`, `"trunk"`, `"info"` |

| Target | Command | Returns |
| --- | --- | --- |
| `stack` | `gt log --stack` | The tracked stack around the current branch |
| `stack_short` | `gt log short` | The same stack, condensed |
| `state` | `gt state` | Stack structure as JSON |
| `parent` | `gt parent` | The current branch's parent |
| `children` | `gt children` | The current branch's children |
| `trunk` | `gt trunk` | The repository's trunk branch |
| `info` | `gt info` | Details of the current branch |

Inspection is read-only. Oh My Pi treats it as a `read` operation and allows it to run concurrently
with other reads.

## Mutations

Every operation below changes the repository. Oh My Pi requires execute approval and runs them
exclusively; `delete` and `abort` always show a prompt. Pi runs all operations sequentially.

### `checkout`

| Field | Type |
| --- | --- |
| `branch` | Existing local branch name |

Runs `gt checkout <branch>`. Requires a clean worktree, and verifies that the named branch is the
one checked out afterwards.

### `create`

| Field | Type |
| --- | --- |
| `name` | Requested branch name |
| `subject` | Single-line commit subject |
| `body` | Commit body |

Runs `gt create <name> --message=<subject> --message=<body>`. Commits the staged tree onto a new
branch and verifies that the new commit's tree matches exactly what was staged, and that unstaged
and untracked files are unchanged.

Graphite may prefix the branch name according to the user's own Graphite configuration, so the
resulting branch name can differ from `name`.

### `modify_commit`

| Field | Type |
| --- | --- |
| `subject` | Single-line commit subject |
| `body` | Commit body |

Runs `gt modify --commit --message=<subject> --message=<body>`, adding the staged tree as a new
commit on the current branch. Verified the same way as `create`.

### `modify_amend`

No fields. Runs `gt modify`, amending the staged tree into the current commit. Verified the same way
as `create`.

### `squash`

| Field | Type |
| --- | --- |
| `subject` | Single-line commit subject |
| `body` | Commit body |

Runs `gt squash --message=<subject> --message=<body>`, collapsing the current branch into one
commit. Requires a non-trunk branch and a clean worktree, and verifies that the branch content is
unchanged and that exactly one commit sits above the parent.

### `fold`

No fields. Runs `gt fold`, merging the current branch into its parent. Requires a non-trunk branch
whose parent is also not trunk, and a clean worktree. Verifies that the parent is checked out with
unchanged content and that the folded branch is gone.

### `rename`

| Field | Type |
| --- | --- |
| `name` | Requested branch name |

Runs `gt rename <name>`. Requires a non-trunk branch, and verifies that the requested name was
reached, that the commit and worktree are unchanged, and that the old branch is gone. As with
`create`, Graphite may apply a configured branch prefix.

### `move`

| Field | Type |
| --- | --- |
| `source` | Existing local branch name |
| `onto` | Existing local branch name, different from `source` |

Runs `gt move --source=<source> --onto=<onto>`, reparenting `source`. Requires both branches to
exist and a clean worktree, and verifies the resulting ancestry and checkout.

### `restack`

| Field | Type |
| --- | --- |
| `branch` | Existing local branch name |

Runs `gt restack --branch=<branch>`, rebasing it onto its parent. Requires a clean worktree, and
verifies that the checkout is preserved.

### `delete`

| Field | Type |
| --- | --- |
| `branch` | Existing local branch name |

Runs `gt delete <branch> --force`. Requires a clean worktree and a branch that is neither trunk nor
currently checked out. Verifies that the checkout is preserved and that the branch is gone.

### `continue`

No fields. Runs `gt continue` to resume an interrupted Graphite operation. Requires an active rebase
with no unresolved paths, and verifies that the repository ends attached to a branch.

### `abort`

No fields. Runs `gt abort --force`, cancelling an in-progress rebase. Requires an active rebase, and
verifies that the repository ends attached to a branch.

## Limits

- Branch names: 1 to 255 characters, validated with `git check-ref-format --branch`, cannot start
  with `-`.
- Commit subject: 1 to 500 characters, single line.
- Commit body: 1 to 20,000 characters.
- NUL bytes, whitespace-only messages, and multi-line subjects are rejected.

## Excluded commands

| Command | Why it is not exposed |
| --- | --- |
| `gt get`, `gt sync`, `gt submit` | Depend on remote state, credentials, cleanup choices, or authorization to publish |
| `gt up`, `gt down`, `gt top`, `gt bottom` | Depend on the current position and prompt when a branch has several children; the model should inspect the stack and request an exact `checkout` |
| `gt absorb`, `gt split`, `gt reorder`, `gt undo` | Choose commits, hunks, or history on the caller's behalf |

The model handles these through the normal Graphite workflow, after reviewing repository state and
getting whatever approval the user requires.
