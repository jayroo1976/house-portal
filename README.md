# House Projects portal

A small self-hosted app for tracking everything the house needs, from essential repairs to nice-to-haves.

- **Items** with room, category, priority (Essential / Important / Nice to have) and status
- **Photos & ideas** per item - take a picture straight from a phone, or choose from the gallery; comments/ideas from each person
- **Quotes** per item (vendor, amount, notes, attach the PDF); accepting one marks it as committed
- **Budget vs committed vs spent** overall and per priority; payments and receipts per item
- **PDF export** (with or without photos) and CSV, honouring the active filters
- **OneDrive backup** nightly (rclone) with automatic restore on an empty `/data`
- **Fuzzy import** (Import button, top right): drop in an invoice/quote PDF, Excel, CSV or text, or paste a list. It works out the lines, vendor, reference, date, amounts, rooms and categories; you tick/edit everything before it's added. See below.
- Two or more named logins, mobile-first UI, installable to a phone home screen

Stack: Node 20, Express, SQLite (better-sqlite3), PDFKit, pdf.js (PDF reading). One container, two volumes.

## Import

No fixed template. It understands:

- **PDF invoices / quotations** (text-based): finds the line-item table, glues wrapped descriptions back together, picks out vendor, invoice/quote number and date, and checks the lines against the document total (a green tick means they add up). If a line has several numbers (qty, rate, VAT, amount) pick which one is the amount; the default is the one that reconciles with the total.
- **Excel (.xlsx) and CSV**: headers are matched loosely (Item/Task/Name, Room/Area, Priority/Importance, Budget/Estimate, Quote, Paid/Spent, Notes...); with no header, the first text column is the item and the last number is the amount.
- **Pasted or .txt lists**: one item per line with the amount at the end (`Pergola 12,000`, `Sofa - AED 4,500`, `Curtains 2.5k`); a heading like `Kitchen:` sets the room for the lines under it.

Choose how amounts are treated: budget only, quote received, accepted quote (committed), or already paid. The original file is attached to every item it creates. Lines that look like existing items are unticked, and a document reference that's already been imported is flagged.

Limits: scanned PDFs and photos can't be read (no OCR); old `.xls` and Word files aren't supported. Room, category and priority are guesses - check them on the review screen.

## Deploy on Unraid

**Option A - Docker Compose** (Compose Manager plugin): copy `docker-compose.yml`, change the passwords, `docker compose up -d`.

**Option B - Unraid template**: put `unraid-template.xml` in `/boot/config/plugins/dockerMan/templates-user/`, then Docker > Add Container > pick `house-portal`.

Image: `ghcr.io/jayroo1976/house-portal:latest` (built by GitHub Actions on every push to `main`).
After the first build, open the package on GitHub (Packages > house-portal > Package settings) and set visibility to **Public**, or `docker login ghcr.io` on Unraid with a read:packages token.

Open `http://<unraid-ip>:3080`.

### Environment

| Variable | Default | Notes |
|---|---|---|
| `APP_USERS` | `admin:changeme` | `name:password,name:password` - **change this** |
| `CURRENCY` | `AED` | label only |
| `APP_TITLE` | `House Projects` | |
| `RCLONE_REMOTE` | _(empty)_ | e.g. `onedrive:HouseProjects`; empty = local backups only |
| `BACKUP_CRON` | `30 2 * * *` | nightly, container timezone (`TZ`); `off` disables |
| `BACKUP_KEEP` | `14` | local DB snapshots retained |
| `SESSION_SECRET` | auto-generated | stored in `/data/.secret` |

### Publishing for both of you

On the home network the LAN address is enough. To reach it from anywhere, put it behind HTTPS - e.g. **Tailscale** (simplest, private, no open ports), a **Cloudflare Tunnel**, or Nginx Proxy Manager / SWAG with a certificate. Do not forward the raw port to the internet. Phone camera capture works over plain HTTP, but "install to home screen" needs HTTPS.

## OneDrive backup setup (once)

1. On any computer with rclone installed: `rclone config` > `n` > name `onedrive` > storage `onedrive` > accept defaults, authorise in the browser, choose *OneDrive Personal* (or Business).
2. Copy the resulting `rclone.conf` (`rclone config file` shows where) to `/mnt/user/appdata/house-portal/config/rclone.conf` on Unraid.
3. Set `RCLONE_REMOTE=onedrive:HouseProjects`.
4. Test: menu (your name, top right) > **4 = Back up now**, then check the `HouseProjects` folder in OneDrive.

What gets copied: a consistent SQLite snapshot (`backups/house-<timestamp>.db`) and all uploaded files (`uploads/`). Copies are additive - nothing is ever deleted from OneDrive by the app.

### Recovery if the server dies

Deploy the container on any machine with the same compose file and the same `rclone.conf`, leave `/data` empty, start it. On first boot the entrypoint finds the newest backup in OneDrive and restores the database and photos automatically.

Manual restore: copy a `house-*.db` from OneDrive to `/data/house.db` and `uploads/*` to `/data/uploads/`.

## Develop locally

```bash
npm install
DATA_DIR=./data APP_USERS="James:test,Wife:test" npm start   # http://localhost:3000
```

## Notes

- Quote status flow: Received > Accepted / Rejected / Expired. Accepting a quote moves the item from Idea/Getting quotes to Approved and counts as *committed* spend.
- Photos are downscaled to 1600px JPEG in the browser before upload (fast on mobile, small PDFs).
- All data lives in `/data`; back that up as well if you also use Unraid's appdata backup.
