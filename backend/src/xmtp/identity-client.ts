// gRPC client for XMTP V3's IdentityApi.
//
// One capability: given an inbox_id, return the set of Ethereum addresses
// currently bound to it. Used to verify a backend caller's signature
// genuinely came from the inbox owner.
//
// We use protobufjs with an inline schema (just the fields we need to
// decode) rather than depending on @xmtp/proto, which has a restrictive
// exports map that blocks reaching its identity submodule. This is the
// canonical way to talk to a gRPC service when you don't want to drag
// in proto codegen tooling — the schema is small, and protobufjs
// transparently skips unknown fields from the server.

import { credentials, Metadata, status as grpcStatus, Client as GrpcClient } from '@grpc/grpc-js';
import protobuf from 'protobufjs';

const DEFAULT_GRPC_URL = 'localhost:5556';
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

// Minimal proto schema — only the fields we actually decode. Unknown
// fields the server includes (signatures, timestamps, etc.) are skipped
// silently by protobufjs.
const PROTO_SCHEMA = `
syntax = "proto3";
package xmtp;

message GetIdentityUpdatesRequest {
  message Request {
    string inbox_id = 1;
    uint64 sequence_id = 2;
  }
  repeated Request requests = 1;
}

message Passkey {
  bytes key = 1;
  optional string relying_party = 2;
}

message MemberIdentifier {
  string ethereum_address = 1;
  bytes installation_public_key = 2;
  Passkey passkey = 3;
}

message CreateInbox {
  string initial_identifier = 1;
  uint64 nonce = 2;
  // initial_identifier_signature = 3 (ignored)
  int32 initial_identifier_kind = 4;
}

message AddAssociation {
  MemberIdentifier new_member_identifier = 1;
  // signatures 2,3 ignored
}

message RevokeAssociation {
  MemberIdentifier member_to_revoke = 1;
  // signature 2 ignored
}

message ChangeRecoveryAddress {
  string new_recovery_identifier = 1;
  // rest ignored
}

message IdentityAction {
  CreateInbox create_inbox = 1;
  AddAssociation add = 2;
  RevokeAssociation revoke = 3;
  ChangeRecoveryAddress change_recovery_address = 4;
}

message IdentityUpdate {
  repeated IdentityAction actions = 1;
  uint64 client_timestamp_ns = 2;
  string inbox_id = 3;
}

message IdentityUpdateLog {
  uint64 sequence_id = 1;
  uint64 server_timestamp_ns = 2;
  IdentityUpdate update = 3;
}

message GetIdentityUpdatesResponseInner {
  string inbox_id = 1;
  repeated IdentityUpdateLog updates = 2;
}

message GetIdentityUpdatesResponse {
  repeated GetIdentityUpdatesResponseInner responses = 1;
}
`;

const root = protobuf.parse(PROTO_SCHEMA, { keepCase: true }).root;
const RequestType = root.lookupType('xmtp.GetIdentityUpdatesRequest');
const ResponseType = root.lookupType('xmtp.GetIdentityUpdatesResponse');

// IdentifierKind enum: 0 unspec, 1 ethereum, 2 passkey
const ETHEREUM_KIND = 1;

interface CachedAddresses {
  addresses: Set<string>;
  fetchedAt: number;
}
const cache: Map<string, CachedAddresses> = new Map();

export interface XmtpIdentityClientOptions {
  url?: string;
  isSecure?: boolean;
}

export async function getInboxAddresses(
  inboxId: string,
  opts: XmtpIdentityClientOptions = {},
): Promise<Set<string> | null> {
  const url = opts.url ?? process.env.XMTP_GRPC_URL ?? DEFAULT_GRPC_URL;
  const isSecure = opts.isSecure ?? process.env.XMTP_GRPC_SECURE === 'true';

  const hit = cache.get(inboxId);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.addresses;
  }

  const response = await fetchIdentityUpdates(inboxId, url, isSecure);
  if (response === null) return null;

  const addresses = computeBoundAddresses(response, inboxId);
  cache.set(inboxId, { addresses, fetchedAt: Date.now() });
  return addresses;
}

export function clearIdentityCache(): void {
  cache.clear();
}

interface DecodedResponse {
  responses?: Array<{
    inbox_id?: string;
    updates?: Array<{
      update?: {
        actions?: Array<{
          create_inbox?: { initial_identifier?: string; initial_identifier_kind?: number };
          add?: { new_member_identifier?: { ethereum_address?: string } };
          revoke?: { member_to_revoke?: { ethereum_address?: string } };
        }>;
      };
    }>;
  }>;
}

async function fetchIdentityUpdates(
  inboxId: string,
  url: string,
  isSecure: boolean,
): Promise<DecodedResponse | null> {
  const message = RequestType.create({
    requests: [{ inbox_id: inboxId, sequence_id: 0 }],
  });
  const requestBytes = Buffer.from(RequestType.encode(message).finish());

  const channelCreds = isSecure
    ? credentials.createSsl()
    : credentials.createInsecure();

  const fullMethodName = '/xmtp.identity.api.v1.IdentityApi/GetIdentityUpdates';
  const responseBytes = await unaryCall(url, channelCreds, fullMethodName, requestBytes);
  if (responseBytes === null) return null;

  const decoded = ResponseType.decode(responseBytes);
  return ResponseType.toObject(decoded, { defaults: true, oneofs: true }) as DecodedResponse;
}

function computeBoundAddresses(response: DecodedResponse, inboxId: string): Set<string> {
  const addresses = new Set<string>();
  const entry = response.responses?.find((r) => r.inbox_id === inboxId)
    ?? response.responses?.[0];
  if (!entry) return addresses;

  for (const log of entry.updates ?? []) {
    for (const action of log.update?.actions ?? []) {
      const create = action.create_inbox;
      if (create?.initial_identifier
        && (create.initial_identifier_kind ?? ETHEREUM_KIND) === ETHEREUM_KIND) {
        addresses.add(create.initial_identifier.toLowerCase());
      }
      const addAddr = action.add?.new_member_identifier?.ethereum_address;
      if (addAddr) addresses.add(addAddr.toLowerCase());

      const revokeAddr = action.revoke?.member_to_revoke?.ethereum_address;
      if (revokeAddr) addresses.delete(revokeAddr.toLowerCase());
    }
  }
  return addresses;
}

async function unaryCall(
  url: string,
  channelCreds: ReturnType<typeof credentials.createInsecure>,
  fullMethodName: string,
  requestBytes: Buffer,
): Promise<Buffer | null> {
  const client = new GrpcClient(url, channelCreds);
  return new Promise<Buffer | null>((resolve, reject) => {
    client.makeUnaryRequest<Buffer, Buffer>(
      fullMethodName,
      (value) => value,
      (value) => Buffer.from(value),
      requestBytes,
      new Metadata(),
      { deadline: Date.now() + REQUEST_TIMEOUT_MS },
      (err, response) => {
        client.close();
        if (err) {
          if (err.code === grpcStatus.NOT_FOUND) {
            resolve(null);
            return;
          }
          reject(err);
          return;
        }
        resolve(response ?? null);
      },
    );
  });
}
