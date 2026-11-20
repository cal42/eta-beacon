// Sign-in shared by the EMS app, ED board and Provider app.
// Each device signs in once; the session is remembered on that device.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

const ROLE_NAMES = { rig: "rig phone", ed: "ED screen", provider: "provider" };

// Resolves with this device's account: { role, unit_id, hospital_id }.
// Shows the #login form if the device isn't signed in yet.
export async function signIn(role) {
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    const acct = await loadAccount();
    if (acct?.role === role) return acct;
    await db.auth.signOut();
    $("loginMsg").textContent = `That login isn't set up as a ${ROLE_NAMES[role]}.`;
  }

  return new Promise((resolve) => {
    const form = $("login");
    form.hidden = false;
    form.onsubmit = async (e) => {
      e.preventDefault();
      $("loginMsg").textContent = "Signing in…";
      const { error } = await db.auth.signInWithPassword({
        email: $("email").value.trim(),
        password: $("password").value,
      });
      if (error) return ($("loginMsg").textContent = error.message);
      const acct = await loadAccount();
      if (acct?.role !== role) {
        await db.auth.signOut();
        return ($("loginMsg").textContent = `That login isn't set up as a ${ROLE_NAMES[role]}.`);
      }
      $("password").value = "";
      form.hidden = true;
      resolve(acct);
    };
  });
}

async function loadAccount() {
  const { data } = await db.from("accounts").select("role, unit_id, hospital_id").maybeSingle();
  return data;
}

export async function signOut() {
  await db.auth.signOut();
  location.reload();
}
