# roc_desk-explorer migration

The explorer and local explorer UI, stores, filesystem services, and shared
file-tree operation hook are now tracked here as the canonical migration
source. The host keeps a compatibility copy until the `FileTreeBackend` and
filesystem IPC adapters are published by `roc_desk-common`.

Next: extract the backend command adapter and add the standalone shell.
