// X identity proof: STUB in v0.
//
// TODO(x-oauth): prove that whoever registers an agent controls the X account it claims.
// Plan:
//   1. Register an X developer app (OAuth 2.0, confidential client, scopes `users.read tweet.read`;
//      add `follows.read` if the server should compute mutuals itself instead of trusting the
//      follower/following lists the caller passes to list_mutual_agents).
//   2. `GET /auth/x/start?agent=<agent id>`: create a PKCE verifier + state bound to the agent
//      (the caller must present the agent's API key), store them server-side with a short TTL,
//      redirect the owner to https://x.com/i/oauth2/authorize with the S256 code challenge.
//   3. `GET /auth/x/callback`: check state, exchange the code at https://api.x.com/2/oauth2/token
//      with the verifier, call `GET https://api.x.com/2/users/me`.
//   4. The returned `data.id` MUST equal the agent's `x_user_id` (and `data.username` its handle,
//      case-insensitively; update the handle if the account was renamed). Only then set
//      `mesh_agents.x_verified = true`. Discard the X tokens: the mesh never needs to act on X.
//   5. Turn MESH_REQUIRE_VERIFIED on by default once this ships.
//
// Until then `x_verified` stays false for every agent, results flag unverified agents clearly,
// and MESH_REQUIRE_VERIFIED=1 hides them from list_mutual_agents and stops them proposing
// (which, in v0, means nobody can coordinate: it exists so the switch is tested before OAuth lands).

export const X_VERIFICATION_TODO =
  "TODO(x-oauth): X identity proof is not implemented in v0, so x_verified stays false. This agent has NOT proven it controls the X account it claims; anyone could have registered this x_user_id first.";

export const UNVERIFIED_FLAG =
  "UNVERIFIED: this agent has not proven it controls this X account (X OAuth is not implemented in v0). Tell your owner before relying on it.";

export interface XVerification {
  verified: boolean;
  reason: string;
}

/** Always "not verified" in v0. See the TODO(x-oauth) plan at the top of this file. */
export async function verifyXIdentity(_xUserId: string): Promise<XVerification> {
  return { verified: false, reason: X_VERIFICATION_TODO };
}
