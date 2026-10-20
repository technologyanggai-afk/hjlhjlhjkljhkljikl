/*
 * supabase-sync.js
 * Menyinkronkan catatan Dashboard Belajar (localStorage) dengan tabel Supabase.
 *
 * CARA PAKAI
 * 1. Jalankan SQL di bagian "SQL" (lihat bawah) di Supabase > SQL Editor.
 * 2. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bawah (pakai anon key, JANGAN service role key).
 * 3. Taruh file ini di sebelah dashboard-belajar.html (ganti namanya jadi index.html jika perlu),
 *    lalu tambahkan sebelum </body>:
 *        <script src="supabase-sync.js"></script>
 * 4. Hosting di tempatmu sendiri (Netlify, Vercel, GitHub Pages). Di halaman yang dihosting
 *    claude.ai, permintaan ke Supabase diblokir.
 *
 * SQL
 *   create table public.study_entries (
 *     id bigint not null,
 *     user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 *     data jsonb not null default '{}',
 *     deleted boolean not null default false,
 *     updated_at timestamptz not null default now(),
 *     primary key (user_id, id)
 *   );
 *   alter table public.study_entries enable row level security;
 *   create policy "baris milik sendiri" on public.study_entries
 *     for all to authenticated
 *     using (user_id = auth.uid()) with check (user_id = auth.uid());
 *
 * Aturan gabung: perubahan terbaru menang. Entri yang dihapus di satu perangkat
 * ikut terhapus di perangkat lain.
 */
(function () {
  "use strict";

  var CFG = {
    url: window.SUPABASE_URL || "ISI_URL_PROYEKMU",       // contoh: https://abcdxyz.supabase.co
    key: window.SUPABASE_ANON_KEY || "ISI_ANON_KEY_MU",   // anon (public) key
    table: "study_entries",
    storeKey: "studylog:v1",
    metaKey: "studylog:sync-meta:v1",
    lib: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"
  };

  var sb = null, user = null, busy = false, timer = null;
  var rawSet = Storage.prototype.setItem;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { rawSet.call(localStorage, k, v); } catch (e) {} }
  function $(id) { return document.getElementById(id); }
  function status(t) { var el = $("sbStat"); if (el) el.textContent = t; }

  // Hash sederhana untuk mendeteksi perubahan lokal (tanpa field id)
  function hash(o) {
    var c = {};
    Object.keys(o).sort().forEach(function (k) { if (k !== "id") c[k] = o[k]; });
    var s = JSON.stringify(c), x = 5381;
    for (var i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
    return x + ":" + s.length;
  }

  // Sinkron otomatis setiap dashboard menyimpan data (ditunda 1,5 detik)
  Storage.prototype.setItem = function (k, v) {
    rawSet.call(this, k, v);
    if (k === CFG.storeKey && !busy) schedule();
  };
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(sync, 1500);
  }

  async function sync() {
    if (!sb || !user || busy) return;
    busy = true;
    status("Menyinkronkan...");
    try {
      var local = JSON.parse(lsGet(CFG.storeKey) || "[]");
      var meta = JSON.parse(lsGet(CFG.metaKey) || "{}");

      var res = await sb.from(CFG.table).select("id,data,deleted,updated_at").eq("user_id", user.id);
      if (res.error) throw res.error;
      var R = {};
      res.data.forEach(function (r) { R[r.id] = r; });

      var now = new Date().toISOString();
      var keep = [], push = [], newMeta = {}, seen = {}, changedLocal = false;

      local.forEach(function (L) {
        seen[L.id] = 1;
        var h = hash(L), m = meta[L.id], r = R[L.id];
        var changed = !m || m.h !== h;
        if (!r || changed) {
          // Baru atau diubah di perangkat ini: kirim ke server
          push.push({ id: L.id, user_id: user.id, data: L, deleted: false, updated_at: now });
          keep.push(L);
          newMeta[L.id] = { h: h, u: now };
        } else if (Date.parse(r.updated_at) > Date.parse(m.u)) {
          // Server lebih baru
          changedLocal = true;
          if (!r.deleted) {
            var N = r.data; N.id = L.id;
            keep.push(N);
            newMeta[L.id] = { h: hash(N), u: r.updated_at };
          }
        } else {
          keep.push(L);
          newMeta[L.id] = m;
        }
      });

      Object.keys(R).forEach(function (id) {
        if (seen[id]) return;
        var r = R[id];
        if (r.deleted) return;
        if (meta[id]) {
          // Pernah tersinkron tapi sudah tidak ada di lokal: berarti dihapus di sini
          push.push({ id: Number(id), user_id: user.id, data: r.data, deleted: true, updated_at: now });
        } else {
          // Entri dari perangkat lain
          var N2 = r.data; N2.id = Number(id);
          keep.push(N2);
          newMeta[id] = { h: hash(N2), u: r.updated_at };
          changedLocal = true;
        }
      });

      if (push.length) {
        var up = await sb.from(CFG.table).upsert(push, { onConflict: "user_id,id" });
        if (up.error) throw up.error;
      }

      lsSet(CFG.metaKey, JSON.stringify(newMeta));
      if (changedLocal) {
        lsSet(CFG.storeKey, JSON.stringify(keep));
        location.reload(); // dashboard membaca ulang data terbaru
        return;
      }
      status("Tersinkron pukul " + new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }));
    } catch (e) {
      status("Gagal sinkron: " + (e && e.message ? e.message : e));
    } finally {
      busy = false;
    }
  }

  function mountPanel() {
    var host = document.querySelector("main");
    if (!host || $("sbPanel")) return;
    var d = document.createElement("section");
    d.id = "sbPanel";
    d.className = "card";
    d.style.marginBottom = "12px";
    d.innerHTML =
      '<h2>Sinkronisasi Supabase</h2>' +
      '<div class="row" id="sbLogin">' +
        '<input id="sbEmail" type="email" placeholder="Email" autocomplete="email" style="max-width:230px">' +
        '<input id="sbPass" type="password" placeholder="Kata sandi (min. 6 karakter)" autocomplete="current-password" style="max-width:230px">' +
        '<button type="button" id="sbIn">Masuk</button>' +
        '<button type="button" class="ghost" id="sbUp">Daftar</button>' +
      '</div>' +
      '<div class="row" id="sbAuthed" hidden>' +
        '<button type="button" id="sbSync">Sinkron sekarang</button>' +
        '<button type="button" class="ghost" id="sbOut">Keluar</button>' +
      '</div>' +
      '<p class="meta" id="sbStat">Belum masuk. Data tetap tersimpan di perangkat ini.</p>';
    host.insertBefore(d, host.children[1] || null);

    $("sbIn").onclick = async function () {
      var r = await sb.auth.signInWithPassword({ email: $("sbEmail").value.trim(), password: $("sbPass").value });
      if (r.error) status("Gagal masuk: " + r.error.message);
    };
    $("sbUp").onclick = async function () {
      var r = await sb.auth.signUp({ email: $("sbEmail").value.trim(), password: $("sbPass").value });
      if (r.error) status("Gagal daftar: " + r.error.message);
      else status("Pendaftaran berhasil. Cek email untuk konfirmasi jika diminta, lalu klik Masuk.");
    };
    $("sbSync").onclick = sync;
    $("sbOut").onclick = async function () { await sb.auth.signOut(); };
  }

  function showAuth(on) {
    var a = $("sbAuthed"), l = $("sbLogin");
    if (a) a.hidden = !on;
    if (l) l.hidden = on;
  }

  function start() {
    if (CFG.url.indexOf("ISI_") === 0 || CFG.key.indexOf("ISI_") === 0) {
      mountPanel();
      status("Isi SUPABASE_URL dan SUPABASE_ANON_KEY di supabase-sync.js terlebih dahulu.");
      return;
    }
    sb = window.supabase.createClient(CFG.url, CFG.key);
    mountPanel();
    sb.auth.onAuthStateChange(function (ev, session) {
      user = session ? session.user : null;
      showAuth(!!user);
      if (user) { status("Masuk sebagai " + user.email); sync(); }
      else status("Belum masuk. Data tetap tersimpan di perangkat ini.");
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) sync();
    });
  }

  if (window.supabase) start();
  else {
    var s = document.createElement("script");
    s.src = CFG.lib;
    s.onload = start;
    s.onerror = function () { mountPanel(); status("Gagal memuat pustaka Supabase."); };
    document.head.appendChild(s);
  }
})();
