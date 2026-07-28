import { createClient } from '@supabase/supabase-js'

// Fill these in .env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY), then restart the dev server.
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null
