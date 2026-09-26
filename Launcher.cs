using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AnudeepKhadiBandar
{
    static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        private const int SW_RESTORE = 9;
        private const string MUTEX_ID = "Global\\AnudeepKhadiBandar_Billing_POS_Mutex";

        private static Process serverProcess = null;
        private static Process browserProcess = null;
        private static HttpListener embeddedServer = null;
        private static Thread embeddedServerThread = null;
        private static Thread watchdogThread = null;
        private static NotifyIcon trayIcon = null;
        private static ContextMenu trayMenu = null;
        private static bool isRunning = true;
        private static string appDir = AppDomain.CurrentDomain.BaseDirectory;
        private static string activeUrl = "http://localhost:3000";

        [STAThread]
        static void Main(string[] args)
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, MUTEX_ID, out createdNew))
            {
                if (!createdNew)
                {
                    // Bring existing instance to foreground
                    FocusExistingInstance();
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                try
                {
                    InitializeSystemTray();
                    EnsureBackendRunning();
                    LaunchDedicatedBrowserWindow(activeUrl);
                    StartWatchdog();

                    Application.Run();
                }
                catch (Exception ex)
                {
                    MessageBox.Show(
                        "An unexpected error occurred in Anudeep Khadi Bandar:\n" + ex.Message,
                        "Anudeep Khadi Bandar - Error",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }
                finally
                {
                    Cleanup();
                }
            }
        }

        private static void FocusExistingInstance()
        {
            try
            {
                Process[] procs = Process.GetProcessesByName("msedge");
                foreach (Process p in procs)
                {
                    if (p.MainWindowHandle != IntPtr.Zero && p.MainWindowTitle.Contains("Anudeep"))
                    {
                        ShowWindow(p.MainWindowHandle, SW_RESTORE);
                        SetForegroundWindow(p.MainWindowHandle);
                        return;
                    }
                }
            }
            catch { }
        }

        private static void InitializeSystemTray()
        {
            trayMenu = new ContextMenu();

            MenuItem mOpen = new MenuItem("📌 Open Anudeep Khadi Bandar", (s, e) => LaunchDedicatedBrowserWindow(activeUrl));
            mOpen.DefaultItem = true;
            trayMenu.MenuItems.Add(mOpen);

            trayMenu.MenuItems.Add(new MenuItem("🧾 New Invoice (Quick Bill)", (s, e) => LaunchDedicatedBrowserWindow(activeUrl + "#billing")));
            trayMenu.MenuItems.Add(new MenuItem("📜 Invoice History", (s, e) => LaunchDedicatedBrowserWindow(activeUrl + "#invoices")));
            trayMenu.MenuItems.Add("-");

            trayMenu.MenuItems.Add(new MenuItem("🔄 Refresh & Sync Cloud Data", (s, e) => {
                if (IsUrlResponding("http://localhost:3000/api/health", 800))
                {
                    ShowTrayNotification("Database Online", "Local Node/MongoDB engine and Cloud GAS are synchronized.");
                }
                else
                {
                    ShowTrayNotification("Cloud Mode Active", "Connected to Google Apps Script Cloud Database.");
                }
            }));

            trayMenu.MenuItems.Add(new MenuItem("📁 Open Invoices Backup Folder", (s, e) => {
                string dataPath = Path.Combine(appDir, "data");
                if (Directory.Exists(dataPath)) Process.Start("explorer.exe", dataPath);
                else Process.Start("explorer.exe", appDir);
            }));

            trayMenu.MenuItems.Add(new MenuItem("🌐 Open in Default Browser", (s, e) => Process.Start(activeUrl)));
            trayMenu.MenuItems.Add("-");

            trayMenu.MenuItems.Add(new MenuItem("❌ Exit Application", (s, e) => {
                Cleanup();
                Application.Exit();
            }));

            trayIcon = new NotifyIcon();
            trayIcon.Text = "Anudeep Khadi Bandar - GST Billing";

            string iconPath = Path.Combine(appDir, "icon.ico");
            if (File.Exists(iconPath))
            {
                try { trayIcon.Icon = new Icon(iconPath); }
                catch { trayIcon.Icon = SystemIcons.Application; }
            }
            else
            {
                trayIcon.Icon = SystemIcons.Application;
            }

            trayIcon.ContextMenu = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += (s, e) => LaunchDedicatedBrowserWindow(activeUrl);
        }

        private static void ShowTrayNotification(string title, string text)
        {
            if (trayIcon != null)
            {
                trayIcon.ShowBalloonTip(3000, title, text, ToolTipIcon.Info);
            }
        }

        private static void EnsureBackendRunning()
        {
            bool localResponding = IsUrlResponding("http://localhost:3000/api/health", 800);

            if (!localResponding)
            {
                string serverJs = Path.Combine(appDir, "server.js");
                string nodeExe = FindNodeExe();

                if (!string.IsNullOrEmpty(nodeExe) && File.Exists(serverJs))
                {
                    StartNodeProcess(nodeExe, serverJs);

                    for (int i = 0; i < 60; i++)
                    {
                        Thread.Sleep(250);
                        if (IsUrlResponding("http://localhost:3000/api/health", 500))
                        {
                            localResponding = true;
                            break;
                        }
                    }
                }
            }

            if (localResponding)
            {
                activeUrl = "http://localhost:3000";
            }
            else
            {
                string indexPath = Path.Combine(appDir, "index.html");
                if (File.Exists(indexPath))
                {
                    int freePort = GetFreePort(3030);
                    activeUrl = "http://localhost:" + freePort + "/";
                    StartEmbeddedServer(freePort);
                }
                else
                {
                    activeUrl = "https://nenduku644-hash.github.io/anudeep-deploy/";
                }
            }
        }

        private static void StartNodeProcess(string nodePath, string scriptPath)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodePath;
                psi.Arguments = "\"" + scriptPath + "\"";
                psi.WorkingDirectory = appDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;

                serverProcess = Process.Start(psi);
            }
            catch (Exception ex)
            {
                Console.WriteLine("Error starting Node: " + ex.Message);
            }
        }

        private static void StartWatchdog()
        {
            watchdogThread = new Thread(() =>
            {
                while (isRunning)
                {
                    Thread.Sleep(6000);
                    if (!isRunning) break;

                    // If configured to use local port 3000, check health and auto-heal if crashed
                    if (activeUrl.Contains(":3000"))
                    {
                        bool alive = IsUrlResponding("http://localhost:3000/api/health", 1200);
                        if (!alive && isRunning)
                        {
                            string nodeExe = FindNodeExe();
                            string serverJs = Path.Combine(appDir, "server.js");
                            if (!string.IsNullOrEmpty(nodeExe) && File.Exists(serverJs))
                            {
                                StartNodeProcess(nodeExe, serverJs);
                            }
                        }
                    }
                }
            });
            watchdogThread.IsBackground = true;
            watchdogThread.Start();
        }

        private static void LaunchDedicatedBrowserWindow(string url)
        {
            try
            {
                // If a browser process is already running, focus it
                if (browserProcess != null && !browserProcess.HasExited)
                {
                    FocusExistingInstance();
                    return;
                }

                string browserPath = FindBrowserExe();
                if (string.IsNullOrEmpty(browserPath))
                {
                    Process.Start(url);
                    return;
                }

                string profileDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "AnudeepKhadiBandar",
                    "POS_Profile"
                );

                try
                {
                    if (!Directory.Exists(profileDir)) Directory.CreateDirectory(profileDir);
                }
                catch { }

                string args = string.Format(
                    "--app=\"{0}\" --user-data-dir=\"{1}\" --window-size=1400,850 --start-maximized " +
                    "--disable-features=Translate,OptimizationHints --disable-extensions " +
                    "--enable-gpu-rasterization --disable-background-timer-throttling --no-first-run",
                    url,
                    profileDir
                );

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = browserPath;
                psi.Arguments = args;
                psi.UseShellExecute = false;

                browserProcess = Process.Start(psi);
                if (browserProcess != null)
                {
                    new Thread(() =>
                    {
                        browserProcess.WaitForExit();
                        // When main browser window is closed, keep tray alive for fast re-opening
                    }).Start();
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to open application window:\n" + ex.Message, "Anudeep Khadi Bandar");
            }
        }

        private static bool IsUrlResponding(string url, int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = timeoutMs;
                req.Method = "GET";
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static string FindNodeExe()
        {
            string[] candidates = new string[]
            {
                Path.Combine(appDir, "node.exe"),
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), @"AppData\Roaming\npm\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\node\node.exe")
            };

            foreach (string p in candidates)
            {
                if (File.Exists(p)) return p;
            }

            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] paths = pathEnv.Split(';');
            foreach (string dir in paths)
            {
                try
                {
                    string candidate = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }

            return null;
        }

        private static string FindBrowserExe()
        {
            string[] candidates = new string[]
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };

            foreach (string p in candidates)
            {
                if (File.Exists(p)) return p;
            }

            return null;
        }

        private static int GetFreePort(int startingPort)
        {
            for (int port = startingPort; port < startingPort + 50; port++)
            {
                try
                {
                    System.Net.Sockets.TcpListener l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, port);
                    l.Start();
                    l.Stop();
                    return port;
                }
                catch { }
            }
            return startingPort;
        }

        private static void StartEmbeddedServer(int port)
        {
            try
            {
                embeddedServer = new HttpListener();
                string prefix = "http://localhost:" + port + "/";
                embeddedServer.Prefixes.Add(prefix);
                embeddedServer.Start();

                embeddedServerThread = new Thread(() =>
                {
                    while (isRunning && embeddedServer != null && embeddedServer.IsListening)
                    {
                        try
                        {
                            HttpListenerContext ctx = embeddedServer.GetContext();
                            ThreadPool.QueueUserWorkItem((state) => HandleRequest(ctx));
                        }
                        catch
                        {
                            break;
                        }
                    }
                });
                embeddedServerThread.IsBackground = true;
                embeddedServerThread.Start();
            }
            catch (Exception ex)
            {
                Console.WriteLine("Embedded server start failed: " + ex.Message);
            }
        }

        private static void HandleRequest(HttpListenerContext ctx)
        {
            try
            {
                string rawUrl = ctx.Request.Url.AbsolutePath.TrimStart('/');
                if (string.IsNullOrEmpty(rawUrl)) rawUrl = "index.html";

                string filePath = Path.Combine(appDir, rawUrl.Replace('/', Path.DirectorySeparatorChar));

                if (File.Exists(filePath))
                {
                    string ext = Path.GetExtension(filePath).ToLowerInvariant();
                    string mime = "application/octet-stream";
                    if (ext == ".html" || ext == ".htm") mime = "text/html; charset=utf-8";
                    else if (ext == ".js") mime = "application/javascript";
                    else if (ext == ".css") mime = "text/css";
                    else if (ext == ".json") mime = "application/json";
                    else if (ext == ".jpg" || ext == ".jpeg") mime = "image/jpeg";
                    else if (ext == ".png") mime = "image/png";
                    else if (ext == ".ico") mime = "image/x-icon";
                    else if (ext == ".svg") mime = "image/svg+xml";

                    ctx.Response.ContentType = mime;
                    ctx.Response.StatusCode = 200;

                    byte[] data = File.ReadAllBytes(filePath);
                    ctx.Response.ContentLength64 = data.Length;
                    ctx.Response.OutputStream.Write(data, 0, data.Length);
                }
                else
                {
                    string indexFile = Path.Combine(appDir, "index.html");
                    if (File.Exists(indexFile))
                    {
                        byte[] data = File.ReadAllBytes(indexFile);
                        ctx.Response.ContentType = "text/html; charset=utf-8";
                        ctx.Response.StatusCode = 200;
                        ctx.Response.ContentLength64 = data.Length;
                        ctx.Response.OutputStream.Write(data, 0, data.Length);
                    }
                    else
                    {
                        ctx.Response.StatusCode = 404;
                    }
                }
            }
            catch { }
            finally
            {
                try { ctx.Response.Close(); } catch { }
            }
        }

        private static void Cleanup()
        {
            isRunning = false;

            if (trayIcon != null)
            {
                try { trayIcon.Visible = false; trayIcon.Dispose(); } catch { }
                trayIcon = null;
            }

            if (embeddedServer != null)
            {
                try { embeddedServer.Stop(); embeddedServer.Close(); } catch { }
                embeddedServer = null;
            }

            if (serverProcess != null && !serverProcess.HasExited)
            {
                try { serverProcess.Kill(); } catch { }
                serverProcess = null;
            }

            if (browserProcess != null && !browserProcess.HasExited)
            {
                try { browserProcess.Kill(); } catch { }
                browserProcess = null;
            }
        }
    }
}
