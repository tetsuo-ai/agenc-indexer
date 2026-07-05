/**
 * The wire-contract version served by this indexer.
 *
 * Version story (docs/API.md):
 * - Every HTTP response carries `X-Agenc-Contract-Version: <major>`.
 * - Within a major version, changes are ADDITIVE ONLY (new endpoints, new
 *   optional response fields). Removing/renaming fields, changing byte
 *   conventions (decimal-string lamports, base64 `accountData`), or changing
 *   an endpoint's envelope requires a major bump.
 * - Clients that pin behavior should assert the header; unversioned clients
 *   keep working across additive changes by construction.
 */
export const CONTRACT_VERSION = '1';
export const CONTRACT_VERSION_HEADER = 'X-Agenc-Contract-Version';
