/* supabase-config.js — Supabase client init (shared global `db`) */
    // 1. Supabase Initialization
    const SUPABASE_URL = "https://rcsrazcvehnjgflkcslo.supabase.co";
    const SUPABASE_KEY = "sb_publishable_KyWxNv1LHTxkTeuXVgkNuA_1jOf7oTp";
    let db = null;
    try {
      if (window.supabase && typeof window.supabase.createClient === 'function') {
        db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
          auth: { persistSession: true, autoRefreshToken: true }
        });
      }
    } catch (e) {
      console.warn("Supabase local active");
    }

