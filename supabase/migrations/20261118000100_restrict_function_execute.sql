-- Trigger functions are only meant to run as triggers, not via the API
revoke execute on function public.gate_signup() from public, anon, authenticated;
revoke execute on function public.after_signup() from public, anon, authenticated;
-- is_admin() is used in policies for signed-in users only
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
