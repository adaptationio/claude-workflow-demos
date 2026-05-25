// Test fixture for the review-branch skill.
// Contains DELIBERATE, unambiguous issues so we can verify the
// review -> adversarial-verify -> synthesize pipeline catches them.
// Expected: bugs reviewer flags getLast / processUser / calculateTotal;
// simplicity flags add; dead-code flags UNUSED_LIMIT.

// BUG (bugs/high): off-by-one — arr[arr.length] is always undefined.
function getLast(arr) {
  return arr[arr.length];
}

// BUG (bugs/high): null-deref — explodes if user/profile/name is missing.
function processUser(user) {
  return user.profile.name.trim();
}

// BUG (bugs/high): off-by-one loop bound — i <= length reads items[length] (undefined.price).
function calculateTotal(items) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price;
  }
  return total;
}

// SMELL (simplicity/low): pointless IIFE wrapper around a one-liner.
function add(a, b) {
  const result = (function () { return a + b; })();
  return result;
}

// DEAD (dead-code/low): never referenced anywhere.
const UNUSED_LIMIT = 42;

module.exports = { getLast, processUser, calculateTotal, add };
