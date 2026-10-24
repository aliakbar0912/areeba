# Shifa License Panel — Dokploy par host karna

Is folder (`_license-server`) mein sab tayyar hai: `Dockerfile`, `.dockerignore`, aur `dokploy.env` (aap ki asli keys ke saath).

> ⚠️ `dokploy.env` aur `data/` folder **kabhi GitHub par upload na karein**. `.gitignore` aur `.dockerignore` mein pehle se exclude hain.

---

## Step 1 — Code Dokploy tak pohanchayein (do mein se ek)

**A) GitHub (recommended — updates aasaan)**
1. GitHub par ek **Private** repo banayein, e.g. `shifa-license-server`.
2. Sirf is `_license-server` folder ka content us repo mein push karein (`data/` aur `dokploy.env` khud skip ho jayenge).

**B) Bina GitHub — zip upload**
1. Is folder ka zip banayein, lekin `data` folder aur `dokploy.env` zip mein **na** daalein.
2. Dokploy application mein provider **Drop** chun kar zip upload karein.

## Step 2 — Dokploy mein Application banayein
1. Dokploy → **Projects → Create Project** (naam: `shifa`).
2. Project ke andar **Create Service → Application** (naam: `license-panel`).
3. **General / Provider**: GitHub repo (branch `main`) ya Drop zip chunein.
4. **Build Type**: **Dockerfile**
   - Dockerfile Path: `Dockerfile`
   - Docker Context Path: `.`

## Step 3 — Environment variables
**Environment** tab kholein aur `dokploy.env` file ka **poora content** wahan paste kar ke Save karein.

## Step 4 — Data ko permanent rakhein (bohot zaroori)
**Advanced → Volumes / Mounts → Add Volume**
- Type: **Volume**
- Volume name: `shifa-license-data`
- Mount path: **`/app/data`**

Ye na kiya to har redeploy par saari licenses, devices aur uploaded updates mit jayengi.

## Step 5 — Domain + HTTPS
**Domains → Add Domain**
- Host: apna domain, e.g. `license.aapkamedical.com` (DNS mein A-record server ke IP par)
  — ya Dokploy ka diya hua free `*.traefik.me` domain test ke liye
- Path: `/`
- **Container Port: `8787`**
- **HTTPS: ON**, Certificate: **Let's Encrypt**

## Step 6 — Deploy
**Deploy** dabayein. Logs mein ye nazar aana chahiye:
```
Admin "admin" created from environment.
Signing public key (must match the app's license-config.json):
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAtgmq9n687ENCeR0WUhrGzPffAi/h+q6rlq7GzziVYso=
-----END PUBLIC KEY-----
Shifa License Server → http://0.0.0.0:8787
```
Agar public key **yahi** hai to server aur software match hain ✅.

Phir `https://aapka-domain/` kholein → username `admin`, password `dokploy.env` mein `ADMIN_PASSWORD` wala. Login ke baad **Settings** se password badlein aur **2FA** on karein.

## Step 7 — Software ko naye URL par point karna
Mujhe apna final URL bata dein (e.g. `https://license.aapkamedical.com`) — main `electron/license/license-config.json` mein `serverUrl` update kar dunga. Phir naya exe build karein:
```
bun run build:win
bun run electron:build
```

---

### Purana local data
Aap ke PC wale local server par jo licenses bani hain woh Dokploy par khud nahi jayengi (naya database banega). Abhi testing ki licenses hain to naye panel par dobara bana lein. Zaroorat ho to `data/license.db` ko volume mein copy bhi kiya ja sakta hai — keys same hain is liye woh wahan chal jayega.

### Updates (exe upload)
Panel ke **Updates** se installer upload hota hai (600 MB tak). Dokploy ka Traefik is mein rukawat nahi dalta.
