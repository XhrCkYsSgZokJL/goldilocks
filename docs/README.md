# Documentation

## Architecture

System design, security model, and key technical decisions.

| Document | Description |
|----------|-------------|
| [Security Architecture](architecture/security-architecture.md) | Single-page map of every security primitive (iOS + backend + trust boundary) |
| [Security — iOS](architecture/security-ios.md) | Device-side security: Secure Enclave wrapping, file protection, keychain, certificate pinning |
| [Security — Backend](architecture/security-backend.md) | Operator-facing security reference: what's protected, how, and what to maintain |
| [Identity System](architecture/identity-system-overview.md) | Single-inbox model, InboxLifecycleManager, InboxStateMachine |
| [Vault & Backup Review](architecture/vault-backup-architecture-review.md) | Architecture review of the vault and backup implementation |

## Operations

Setup, deployment, and day-to-day operations.

| Document | Description |
|----------|-------------|
| [First-Time Walkthrough](operations/walkthrough.md) | Linear guide from clean Mac to verified working security stack (~30 min) |
| [Production Setup](operations/production-setup.md) | Full runbook: dev environment to live Cloudflare tunnel |
| [Encryption & Backup Plan](operations/encryption-and-backup.md) | Design and implementation of the 5-layer security stack (F1-F5) |
| [Backup/Restore Hardening](operations/backup-restore-hardening.md) | Hardening plan for backup and restore mechanisms |
| [Environments](operations/environments.md) | iOS environment configuration: Local, Dev, Production schemes and bundle IDs |
| [Release Process](operations/release.md) | Automated release workflow: tag, build, deploy |

## Architecture Decision Records

Significant design decisions and their rationale. See the [ADR template](templates/TEMPLATE_ADR.md) for creating new ones.

| ADR | Title |
|-----|-------|
| [001](adr/001-invite-system-architecture.md) | Decentralized Invite System with Cryptographic Tokens |
| [002](adr/002-per-conversation-identity-model.md) | Per-Conversation Identity Model |
| [003](adr/003-inbox-lifecycle-management.md) | Inbox Lifecycle Management with LRU Eviction |
| [004](adr/004-explode-feature.md) | Conversation Explode Feature |
| [005](adr/005-member-profile-system.md) | Profile Storage in Conversation Metadata |
| [006](adr/006-lock-convo-feature.md) | Lock Convo Feature |
| [007](adr/007-default-conversation-display-name.md) | Default Conversation Display Name and Emoji |
| [008](adr/008-asset-lifecycle-and-renewal.md) | Asset Lifecycle and Renewal Strategy |
| [009](adr/009-encrypted-conversation-images.md) | Encrypted Conversation Images |
| [010](adr/010-public-preview-image-toggle.md) | Public Preview Image Toggle |
| [011](adr/011-single-inbox-identity-model.md) | Single Inbox Identity Model |

## Feature Plans

PRDs and implementation plans live in [`plans/`](plans/). Use the [PRD template](templates/TEMPLATE_PRD.md) for new features.

## Investigations

Debugging deep-dives and research notes live in [`investigations/`](investigations/).

## Templates

| Template | Use for |
|----------|---------|
| [PRD](templates/TEMPLATE_PRD.md) | New feature requirements |
| [ADR](templates/TEMPLATE_ADR.md) | Architecture decisions |
| [One-Pager](templates/TEMPLATE_ONE_PAGER.md) | Brief feature/design overviews |
