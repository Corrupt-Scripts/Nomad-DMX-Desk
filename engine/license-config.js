'use strict';
// Licensing settings. Nothing in this file is secret.
module.exports = {
  // Public half of the admin signing key. The private half lives only with the owner (see tools/make-admin-key.js).
  ADMIN_PUBLIC_KEY: '6iLYZTyraWu4x9LFDC8c3kjkdR6V17wB2f6PR99QBCU=',
  POLAR: {
    api: 'https://api.polar.sh',        // use https://sandbox-api.polar.sh while testing with a Polar sandbox organisation
    organizationId: 'f090df63-c15f-4495-91f5-9dcc2a713c4a', // B-Box Polar organisation (not secret)
  },
  FREE_LIMITS: { universes: 1, fixtures: 16 },
  CHECK_DAYS: 7,                        // a saved key is re-checked with Polar about once a week (no retyping)
  GRACE_DAYS: 21,                       // a key keeps working this long after its last successful check, so a week offline is fine
};
