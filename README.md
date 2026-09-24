# Anudeep Khadi Bandar - Tax Invoice & Billing System

A high-speed, modern GST billing and tax invoice web application with automated WhatsApp invoice delivery, Telegram backup, customer autocomplete, and dual-database support (Local MongoDB & Cloud Google Apps Script).

---

## 🚀 Instant Deployment / Publishing

### Option 1: Deploy on Vercel (Fastest & Free)
1. Go to [vercel.com](https://vercel.com) and log in with your GitHub account.
2. Click **"Add New Project"** $\rightarrow$ **"Import"** and select **`anudeep-deploy`**.
3. Keep default settings (the included `vercel.json` automatically configures everything).
4. Click **Deploy**. Your app will be live with a free SSL domain (e.g., `https://anudeep-deploy.vercel.app`) in under 1 minute!

---

### Option 2: Deploy on GitHub Pages (100% Free)
1. Push your commits to GitHub:
   ```bash
   git push origin main
   ```
2. In your GitHub repository:
   - Go to **Settings** $\rightarrow$ **Pages** (in the left sidebar).
   - Under **Build and deployment** > **Source**, choose **"Deploy from a branch"**.
   - Under **Branch**, select `main` and `/ (root)`, then click **Save**.
3. Within 1–2 minutes, your website will be live at:
   `https://nenduku644-hash.github.io/anudeep-deploy/`

---

### Option 3: Full Stack Backend (with WhatsApp Web Bot & MongoDB)
For automated WhatsApp sending from a server, deploy using the included `Dockerfile` and `render.yaml` to **Render.com** or **Railway**:
1. Connect your repository `nenduku644-hash/anudeep-deploy` on [render.com](https://render.com).
2. Render will automatically detect `render.yaml` and `Dockerfile` (with Chromium pre-configured).
3. Add your `MONGO_URI` environment variable and launch!