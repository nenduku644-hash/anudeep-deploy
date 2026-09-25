using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AnudeepKhadiBandar
{
    static class Program
    {
        private static Process serverProcess = null;
        private static HttpListener embeddedServer = null;
        private static Thread embeddedServerThread = null;
        private static bool isRunning = true;
        private static string appDir = AppDomain.CurrentDomain.BaseDirectory;

        [STAThread]
        static void Main(string[] args)
        {
            try
            {
                string targetUrl = "http://localhost:3000";
                bool localServerRunning = IsUrlResponding("http://localhost:3000/api/health", 800);

                if (!localServerRunning)
                {
                    // Attempt to launch local Node backend if server.js exists
                    string serverJsPath = Path.Combine(appDir, "server.js");
                    string nodeExePath = FindNodeExe();

                    if (!string.IsNullOrEmpty(nodeExePath) && File.Exists(serverJsPath))
                    {
                        try
                        {
                            ProcessStartInfo psi = new ProcessStartInfo();
                            psi.FileName = nodeExePath;
                            psi.Arguments = "\"" + serverJsPath + "\"";
                            psi.WorkingDirectory = appDir;
                            psi.UseShellExecute = false;
                            psi.CreateNoWindow = true;
                            psi.WindowStyle = ProcessWindowStyle.Hidden;

                            serverProcess = Process.Start(psi);

                            // Wait up to 3 seconds for server to initialize
                            for (int i = 0; i < 6; i++)
                            {
                                Thread.Sleep(500);
                                if (IsUrlResponding("http://localhost:3000/api/health", 500))
                                {
                                    localServerRunning = true;
                                    break;
                                }
                            }
                        }
                        catch (Exception ex)
                        {
                            Console.WriteLine("Node start error: " + ex.Message);
                        }
                    }
                }

                // If local server is still not running, start embedded HTTP server for local index.html or fallback to cloud URL
                if (!localServerRunning)
                {
                    string indexPath = Path.Combine(appDir, "index.html");
                    if (File.Exists(indexPath))
                    {
                        int freePort = GetFreePort(3030);
                        targetUrl = "http://localhost:" + freePort + "/";
                        StartEmbeddedServer(freePort);
                    }
                    else
                    {
                        // Fallback to live deployed Cloud URL
                        targetUrl = "https://nenduku644-hash.github.io/anudeep-deploy/";
                    }
                }

                // Launch dedicated Chromium App Window (Microsoft Edge or Google Chrome)
                string browserPath = FindBrowserExe();
                if (string.IsNullOrEmpty(browserPath))
                {
                    // Fallback to default browser if neither Edge nor Chrome found
                    Process.Start(targetUrl);
                    return;
                }

                string profileDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "AnudeepKhadiBandar",
                    "Profile"
                );

                try
                {
                    if (!Directory.Exists(profileDir))
                    {
                        Directory.CreateDirectory(profileDir);
                    }
                }
                catch { }

                string browserArgs = string.Format(
                    "--app=\"{0}\" --user-data-dir=\"{1}\" --window-size=1366,768 --start-maximized --disable-features=Translate --disable-extensions --no-first-run",
                    targetUrl,
                    profileDir
                );

                ProcessStartInfo browserPsi = new ProcessStartInfo();
                browserPsi.FileName = browserPath;
                browserPsi.Arguments = browserArgs;
                browserPsi.UseShellExecute = false;

                Process browserProc = Process.Start(browserPsi);
                if (browserProc != null)
                {
                    browserProc.WaitForExit();
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "An unexpected error occurred launching Anudeep Khadi Bandar:\n" + ex.Message,
                    "Anudeep Khadi Bandar",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            finally
            {
                Cleanup();
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

            // Check PATH environment variable
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
                    // Fallback to index.html for SPA routing
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

            if (embeddedServer != null)
            {
                try { embeddedServer.Stop(); embeddedServer.Close(); } catch { }
                embeddedServer = null;
            }

            if (serverProcess != null && !serverProcess.HasExited)
            {
                try
                {
                    serverProcess.Kill();
                }
                catch { }
                serverProcess = null;
            }
        }
    }
}
