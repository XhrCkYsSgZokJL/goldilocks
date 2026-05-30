# Goldilocks

Goldilocks is a privacy-first advisory platform built on the [XMTP protocol](https://xmtp.org). It pairs an iOS app with a backend service to provide end-to-end encrypted messaging between clients and their advisory teams.

The iOS app is a whitelabeled fork of [Convos](https://convos.org), extended with Goldilocks-specific features: tiered advisory groups, per-seat billing, server-side XMTP agents, and a full security stack (Secure Enclave identity wrapping, encrypted backups, sealed secrets, mTLS to Postgres).

## Prerequisites

- macOS with Xcode 16+
- Node.js 20+
- Docker Desktop (for Postgres and the local XMTP node)
- Homebrew (for SwiftLint, SwiftFormat)

## Quick Start

```bash
# 1. Install iOS dependencies (SwiftLint, SwiftFormat, git hooks)
./Scripts/setup.sh

# 2. Start the full dev environment (Docker + backend + agents)
./dev/start

# 3. Open the iOS app in Xcode
open Convos.xcodeproj
# Select the "Convos (Local)" scheme and run on a simulator
```

That's it. `./dev/start` handles npm install, Docker (XMTP node + Postgres), database migrations, and launches the backend server and agents as background processes.

### Other commands

```bash
./dev/setup      # First-time setup (generates .env.dev + secrets)
./dev/stop       # Stop everything (preserves data)
./dev/reset      # Wipe all data and start fresh
./dev/status     # Check what's running
./dev/test       # Run ConvosCore tests (starts Docker automatically)
```

### Operations scripts

For admin management, security configuration, backups, and key management:

```bash
./dev/admins list             # List admin slots
./dev/admins add <name>       # Add an admin (prints upgrade code)
./dev/backup list             # List backup snapshots
./dev/keys status             # Show key material status
./dev/security status         # Show security config
```

## Project Structure

```
goldilocks/
├── Convos/                    iOS app (SwiftUI views + ViewModels)
├── Convos.xcodeproj/
├── ConvosCore/                Swift Package: business logic, models, services
├── ConvosAppData/             Shared foundation (protobuf, serialization)
├── ConvosInvites/             Invite system package
├── ConvosCoreiOS/             iOS-specific bridge (UIKit, push notifications)
├── ConvosLogging/             Logging package
├── dev/                       Dev scripts + XMTP Docker Compose
├── shared/
│   ├── api-types.ts           Canonical API type definitions (TypeScript)
│   ├── brand.json             Whitelabel configuration
│   └── codegen/               TypeScript -> Swift/Zod generators
├── backend/                   Node.js backend
│   ├── src/                   Fastify server, routes, agents
│   ├── scripts/               Deployment, security, admin scripts
│   └── docker-compose.yml     Postgres + notification server
├── docs/                      All project documentation
├── package.json               Root: codegen scripts
└── CLAUDE.md                  AI assistant instructions
```

The iOS code lives at the repo root (not in a subdirectory) to preserve cherry-pick compatibility with the upstream [convos-ios](https://github.com/ephemeraHQ/convos-ios) repo.

## Development

### iOS App

Open `Convos.xcodeproj` in Xcode. Three schemes match the three environments:

| Scheme | Environment | Backend | XMTP Network |
|--------|-------------|---------|---------------|
| Convos (Local) | Development | localhost:4000 | Local node |
| Convos (Dev) | Staging | api.dev.convos.xyz | XMTP Dev |
| Convos (Prod) | Production | Cloudflare tunnel | XMTP Prod |

For local development, use **Convos (Local)**. The backend must be running (`./dev/start`).

### Backend

The backend runs as background processes managed by `./dev/start`. Logs are in `backend/.dev-run/`:

```bash
tail -f backend/.dev-run/server-*.log    # API server
tail -f backend/.dev-run/agent-*.log     # XMTP agents
```

To run the server or agents in the foreground (for debugging):

```bash
cd backend
npm run server:dev     # Fastify API server on :4000
npm run agents:dev     # XMTP agents (admins + reports)
```

### Shared Type System

API types are defined once in TypeScript and code-generated into Swift Codable structs and Zod schemas:

```bash
npm run codegen          # Generate both Swift and Zod
npm run codegen:check    # Verify generated files are fresh
```

When adding or changing an API type: edit `shared/api-types.ts`, run `npm run codegen`, commit the generated files.

### Whitelabel Configuration

All brand strings, group names, icons, pricing, tier config, and legal copy are driven by `shared/brand.json`. The iOS app reads it via `BrandConfig.shared`. The backend imports it directly.

To rebrand: edit `shared/brand.json` and rebuild. No code changes needed.

### Testing

```bash
# ConvosCore tests (requires Docker)
./dev/test

# Unit tests only (no Docker)
./dev/test --unit

# Backend tests
cd backend && npm test
```

### Code Quality

```bash
swiftlint                # Check for lint issues
swiftlint --fix          # Auto-fix
swiftformat .            # Format Swift code
cd backend && npm run lint       # ESLint
cd backend && npm run typecheck  # TypeScript
```

Pre-commit hooks run SwiftFormat and SwiftLint automatically.

## Documentation

All documentation lives in [`docs/`](docs/README.md):

- **[Architecture](docs/architecture/)** — security model, identity system, system overview
- **[Operations](docs/operations/)** — production setup, deployment, backups, environments
- **[ADRs](docs/adr/)** — architecture decision records
- **[Plans](docs/plans/)** — feature PRDs and implementation plans
- **[Investigations](docs/investigations/)** — debugging and research notes

## Security

Goldilocks has a layered security model spanning iOS and backend:

- **iOS**: Secure Enclave identity wrapping, file protection, certificate pinning, screen capture blocking
- **Backend**: Encrypted backups (restic), sealed secrets (SOPS+age), column encryption (AES-256-GCM), internal mTLS, Cloudflare tunnel
- **Protocol**: XMTP MLS for end-to-end encrypted messaging

See [docs/architecture/security-architecture.md](docs/architecture/security-architecture.md) for the full security map.

## License

Proprietary. All rights reserved.
