import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

// Service-role client — the worker runs outside any user session and needs
// to bypass RLS's `authenticated`-scoped policies to claim/update jobs and
// write launch_locations results directly.
export const db = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
