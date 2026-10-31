using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("词感 WordSense")]
[assembly: AssemblyProduct("词感")]
[assembly: AssemblyDescription("句子跟读刷词 · 桌面版")]
[assembly: AssemblyVersion("1.3.0.0")]
[assembly: AssemblyFileVersion("1.3.0.0")]

static class Program
{
    private static int Port = GetPort();
    private static string baseDir;
    private static string appDir;
    private static TcpListener listener;

    private static int GetPort()
    {
        int p;
        if (int.TryParse(Environment.GetEnvironmentVariable("WORDSENSE_NATIVE_PORT"), out p) && p > 1024 && p < 65000) return p;
        return 47821;
    }

    [STAThread]
    private static void Main(string[] args)
    {
        if (args != null)
        {
            for (int i = 0; i < args.Length; i++)
            {
                int p;
                if (args[i].StartsWith("--port=") && int.TryParse(args[i].Substring(7), out p) && p > 1024 && p < 65000) Port = p;
            }
        }
        AppDomain.CurrentDomain.AssemblyResolve += ResolveManaged;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            Application.Run(new MainForm());
        }
        catch (Exception ex)
        {
            Log("FATAL " + ex);
            MessageBox.Show("词感启动失败：\n" + ex.Message, "词感", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static Assembly ResolveManaged(object sender, ResolveEventArgs args)
    {
        try
        {
            string name = new AssemblyName(args.Name).Name;
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name + ".dll"))
            {
                if (s == null) return null;
                byte[] buf = new byte[s.Length];
                s.Read(buf, 0, buf.Length);
                return Assembly.Load(buf);
            }
        }
        catch { return null; }
    }

    internal static string BaseDir { get { return baseDir; } }
    internal static string AppDir { get { return appDir; } }
    internal static int ServerPort { get { return Port; } }
    internal static string Url { get { return "http://127.0.0.1:" + Port + "/?desktop=1"; } }

    internal static void Log(string message)
    {
        try
        {
            if (string.IsNullOrEmpty(baseDir)) return;
            Directory.CreateDirectory(baseDir);
            File.AppendAllText(Path.Combine(baseDir, "boot.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + "\r\n");
        }
        catch { }
    }

    internal static void StartServer()
    {
        listener = new TcpListener(IPAddress.Loopback, Port);
        try { listener.Start(); }
        catch (SocketException)
        {
            throw new Exception("本地端口 " + Port + " 被占用。可能已有一个「词感」窗口在运行，请先在任务管理器结束旧进程后重试。");
        }
        Thread t = new Thread(AcceptLoop);
        t.IsBackground = true;
        t.Start();
    }

    internal static void StopServer()
    {
        try { if (listener != null) listener.Stop(); } catch { }
        listener = null;
    }

    private static void AcceptLoop()
    {
        while (listener != null)
        {
            TcpClient client = null;
            try { client = listener.AcceptTcpClient(); }
            catch { break; }
            ThreadPool.QueueUserWorkItem(HandleClient, client);
        }
    }

    private static void HandleClient(object state)
    {
        TcpClient client = state as TcpClient;
        if (client == null) return;
        try
        {
            using (NetworkStream ns = client.GetStream())
            {
                byte[] buffer = new byte[8192];
                int total = 0;
                while (total < buffer.Length)
                {
                    int n = ns.Read(buffer, total, buffer.Length - total);
                    if (n <= 0) break;
                    total += n;
                    string sofar = Encoding.ASCII.GetString(buffer, 0, total);
                    if (sofar.Contains("\r\n\r\n") || sofar.Contains("\n\n")) break;
                }
                if (total <= 0) return;
                string request = Encoding.ASCII.GetString(buffer, 0, total);
                string[] parts = request.Split('\n')[0].Trim().Split(' ');
                if (parts.Length < 2) { WriteStatus(ns, "400 Bad Request"); return; }
                string method = parts[0].ToUpperInvariant();
                if (method != "GET" && method != "HEAD") { WriteStatus(ns, "405 Method Not Allowed"); return; }
                string target = parts[1];
                if (target.StartsWith("/__tts", StringComparison.OrdinalIgnoreCase))
                {
                    HandleTts(ns, target);
                    return;
                }
                int q = target.IndexOf('?');
                if (q >= 0) target = target.Substring(0, q);
                string decoded;
                try { decoded = Uri.UnescapeDataString(target); } catch { decoded = target; }

                if (decoded == "/__ping")
                {
                    WriteRaw(ns, "HTTP/1.1 204 No Content\r\nX-WordSense: 1\r\nConnection: close\r\n\r\n", null);
                    return;
                }
                if (decoded == "/__asr/status")
                {
                    WriteJson(ns, "{\"available\":false}");
                    return;
                }

                string relative = decoded.Replace('/', Path.DirectorySeparatorChar).TrimStart(Path.DirectorySeparatorChar, '\\');
                if (relative.Length == 0 || relative.EndsWith(Path.DirectorySeparatorChar.ToString()))
                    relative = Path.Combine(relative, "index.html");
                string root = Path.GetFullPath(appDir) + Path.DirectorySeparatorChar;
                string full = Path.GetFullPath(Path.Combine(appDir, relative));
                if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
                {
                    WriteStatus(ns, "404 Not Found");
                    return;
                }
                byte[] body = File.ReadAllBytes(full);
                string headers = "HTTP/1.1 200 OK\r\nContent-Type: " + ContentType(full) +
                                 "\r\nContent-Length: " + body.Length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                if (method == "HEAD") WriteRaw(ns, headers, null);
                else WriteRaw(ns, headers, body);
            }
        }
        catch { }
        finally
        {
            try { client.Close(); } catch { }
        }
    }

    private static void WriteJson(NetworkStream ns, string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json);
        string headers = "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n" +
                         "Content-Length: " + body.Length + "\r\nAccess-Control-Allow-Origin: *\r\n" +
                         "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
        WriteRaw(ns, headers, body);
    }

    private static string QueryValue(string target, string name)
    {
        int q = target.IndexOf('?');
        if (q < 0) return "";
        string[] parts = target.Substring(q + 1).Split('&');
        for (int i = 0; i < parts.Length; i++)
        {
            int eq = parts[i].IndexOf('=');
            if (eq < 0) continue;
            string key = parts[i].Substring(0, eq);
            if (!string.Equals(key, name, StringComparison.OrdinalIgnoreCase)) continue;
            try { return Uri.UnescapeDataString(parts[i].Substring(eq + 1)); }
            catch { return ""; }
        }
        return "";
    }

    private static void HandleTts(NetworkStream ns, string target)
    {
        string kind = QueryValue(target, "kind");
        string text = QueryValue(target, "text").Trim();
        if (text.Length == 0 || text.Length > 500)
        {
            WriteStatus(ns, "400 Bad Request");
            return;
        }
        string url;
        string referer;
        if (string.Equals(kind, "youdao", StringComparison.OrdinalIgnoreCase))
        {
            url = "https://dict.youdao.com/dictvoice?audio=" + Uri.EscapeDataString(text) + "&type=2";
            referer = "https://dict.youdao.com/";
        }
        else
        {
            url = "https://fanyi.baidu.com/gettts?lan=en&text=" + Uri.EscapeDataString(text) + "&spd=3&source=web";
            referer = "https://fanyi.baidu.com/";
        }
        try
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.UserAgent = "Mozilla/5.0";
            req.Referer = referer;
            req.Timeout = 15000;
            req.ReadWriteTimeout = 15000;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (Stream input = resp.GetResponseStream())
            using (MemoryStream ms = new MemoryStream())
            {
                input.CopyTo(ms);
                byte[] body = ms.ToArray();
                string type = string.IsNullOrEmpty(resp.ContentType) ? "audio/mpeg" : resp.ContentType;
                string headers = "HTTP/1.1 200 OK\r\nContent-Type: " + type +
                                 "\r\nContent-Length: " + body.Length +
                                 "\r\nAccess-Control-Allow-Origin: *" +
                                 "\r\nCache-Control: public, max-age=86400" +
                                 "\r\nConnection: close\r\n\r\n";
                WriteRaw(ns, headers, body);
            }
        }
        catch
        {
            WriteStatus(ns, "502 Bad Gateway");
        }
    }

    private static void WriteRaw(NetworkStream ns, string headers, byte[] body)
    {
        byte[] head = Encoding.ASCII.GetBytes(headers);
        ns.Write(head, 0, head.Length);
        if (body != null && body.Length > 0) ns.Write(body, 0, body.Length);
    }

    private static void WriteStatus(NetworkStream ns, string status)
    {
        WriteRaw(ns, "HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", null);
    }

    private static string ContentType(string path)
    {
        switch (Path.GetExtension(path).ToLowerInvariant())
        {
            case ".html": return "text/html; charset=utf-8";
            case ".css": return "text/css; charset=utf-8";
            case ".js": return "application/javascript; charset=utf-8";
            case ".json": return "application/json; charset=utf-8";
            case ".png": return "image/png";
            case ".jpg":
            case ".jpeg": return "image/jpeg";
            case ".svg": return "image/svg+xml";
            case ".ico": return "image/x-icon";
            case ".woff2": return "font/woff2";
            case ".txt": return "text/plain; charset=utf-8";
            default: return "application/octet-stream";
        }
    }

    internal static void PrepareApp()
    {
        baseDir = ResolveBaseDir();
        Directory.CreateDirectory(baseDir);
        Log("START baseDir=" + baseDir);
        ExtractNativeLoader();
        EnsureApp();
        CopyOldLocalStorage();
        StartServer();
        Log("server=" + Url + " appDir=" + appDir);
    }

    private static string ResolveBaseDir()
    {
        string overrideHome = Environment.GetEnvironmentVariable("WORDSENSE_NATIVE_HOME");
        if (!string.IsNullOrEmpty(overrideHome))
        {
            Directory.CreateDirectory(overrideHome);
            return overrideHome;
        }
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidates = new string[]
        {
            Path.Combine(local, "WordSenseNative"),
            Path.Combine(local, "WordSenseData"),
            Path.Combine(Path.GetTempPath(), "WordSenseNative")
        };
        foreach (string path in candidates)
        {
            try
            {
                Directory.CreateDirectory(path);
                string probe = Path.Combine(path, ".write-test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return path;
            }
            catch { }
        }
        return Path.Combine(Path.GetTempPath(), "WordSenseNative");
    }

    private static void ExtractNativeLoader()
    {
        try
        {
            string dst = Path.Combine(baseDir, "WebView2Loader.dll");
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("WebView2Loader.dll"))
            {
                if (s == null) return;
                if (!File.Exists(dst) || new FileInfo(dst).Length != s.Length)
                {
                    using (FileStream fs = File.Create(dst)) s.CopyTo(fs);
                }
            }
            SetDllDirectory(baseDir);
        }
        catch (Exception ex)
        {
            Log("ExtractNativeLoader " + ex.Message);
        }
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern bool SetDllDirectory(string path);

    private static void EnsureApp()
    {
        string version = Assembly.GetExecutingAssembly().GetName().Version.ToString();
        appDir = Path.Combine(baseDir, "app-" + version);
        string ready = Path.Combine(appDir, ".ready");
        if (Directory.Exists(appDir) && File.Exists(ready)) return;

        if (Directory.Exists(appDir)) Directory.Delete(appDir, true);
        Directory.CreateDirectory(appDir);
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.zip"))
        {
            if (s == null) throw new Exception("内置网页资源缺失，请重新下载完整程序");
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string name = entry.FullName.Replace('\\', '/');
                    if (name.EndsWith("/")) continue;
                    string dst = Path.Combine(appDir, name.Replace('/', Path.DirectorySeparatorChar));
                    Directory.CreateDirectory(Path.GetDirectoryName(dst));
                    using (Stream input = entry.Open())
                    using (FileStream output = File.Create(dst)) input.CopyTo(output);
                }
            }
        }
        File.WriteAllText(ready, DateTime.Now.ToString("s"));
    }

    private static void CopyOldLocalStorage()
    {
        try
        {
            string userData = Path.Combine(baseDir, "WebView2");
            string dst = Path.Combine(userData, "EBWebView", "Default", "Local Storage");
            if (Directory.Exists(dst)) return;
            string[] oldBases = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WordSense"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WordSenseData")
            };
            foreach (string oldBase in oldBases)
            {
                string src = Path.Combine(oldBase, "profile", "Default", "Local Storage");
                if (!Directory.Exists(src)) continue;
                Directory.CreateDirectory(dst);
                CopyDirectory(src, dst);
                Log("migrated localStorage from " + src);
                return;
            }
        }
        catch (Exception ex)
        {
            Log("localStorage migration failed " + ex.Message);
        }
    }

    private static void CopyDirectory(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (string file in Directory.GetFiles(src))
        {
            try { File.Copy(file, Path.Combine(dst, Path.GetFileName(file)), true); } catch { }
        }
        foreach (string dir in Directory.GetDirectories(src))
        {
            CopyDirectory(dir, Path.Combine(dst, Path.GetFileName(dir)));
        }
    }
}

class MainForm : Form
{
    private readonly WebView2 webView;

    public MainForm()
    {
        Text = "词感";
        Width = 1280;
        Height = 900;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(980, 700);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        webView = new WebView2();
        webView.Dock = DockStyle.Fill;
        Controls.Add(webView);
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        try
        {
            Program.PrepareApp();
            string version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            Program.Log("WebView2 runtime=" + version);
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(
                null, Path.Combine(Program.BaseDir, "WebView2"),
                new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"));
            await webView.EnsureCoreWebView2Async(env);

            CoreWebView2 core = webView.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsSwipeNavigationEnabled = false;
            core.PermissionRequested += OnPermissionRequested;
            core.NewWindowRequested += OnNewWindowRequested;
            core.NavigationCompleted += OnNavigationCompleted;
            core.ProcessFailed += (s, args) => Program.Log("ProcessFailed " + args.ProcessFailedKind);

            core.Navigate(Program.Url);
        }
        catch (Exception ex)
        {
            Program.Log("INIT ERROR " + ex);
            MessageBox.Show(
                "词感启动失败：\n\n" + ex.Message + "\n\n" +
                "如果提示缺少 WebView2，请安装：\n" +
                "https://developer.microsoft.com/microsoft-edge/webview2/",
                "词感", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private void OnPermissionRequested(object sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        if (e.PermissionKind == CoreWebView2PermissionKind.Microphone ||
            e.PermissionKind == CoreWebView2PermissionKind.Notifications)
        {
            e.State = CoreWebView2PermissionState.Allow;
        }
        else
        {
            e.State = CoreWebView2PermissionState.Deny;
        }
    }

    private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        try { Process.Start(e.Uri); } catch { }
    }

    private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        try
        {
            string result = await webView.CoreWebView2.ExecuteScriptAsync(
                "(() => { try { return JSON.stringify({ storage: localStorage.getItem('wordsense.v1') ? 'data' : 'empty', voices: speechSynthesis.getVoices().length, media: !!navigator.mediaDevices, rec: !!(window.SpeechRecognition || window.webkitSpeechRecognition) }); } catch(e) { return String(e); } })()");
            Program.Log("navigation completed " + result);
        }
        catch (Exception ex)
        {
            Program.Log("navigation check " + ex.Message);
        }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        Program.StopServer();
        base.OnFormClosed(e);
    }
}
