// Fork (automatic updates, docs/claude-code.md): the desktop icon of the
// fork's app. It opens LearnHarness updated to the fork's main.
//
// On each click:
// 1. If the app is open, it brings it forward.
// 2. It asks GitHub for the fork's main (6 seconds at most). When main moved
//    since the last update run, it starts the update task (auto-update.ps1)
//    at once.
// 3. While a new version builds, a small window shows the progress. Open now
//    skips the wait; closing the window cancels the click.
// 4. A version built while the app was open is installed before it opens.
// 5. If the last update failed, the app opens and the window says why.
// The window follows the app's interface language. Any problem in here still
// opens the installed app.
//
// It is a program, not a script, because Kaspersky deletes shortcuts that
// start a hidden PowerShell. build-launcher.ps1 compiles it with the C#
// compiler that ships with Windows (.NET Framework 4), so it is C# 5.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("LearnHarness launcher")]
[assembly: AssemblyDescription("Opens LearnHarness updated to the fork's main")]
[assembly: AssemblyProduct("LearnHarness (Claude fork)")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
// Without it .NET runs the program in 4.0 compatibility mode, which hides
// the buttons from screen readers and other accessibility tools.
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace LearnHarnessFork
{
    static class Program
    {
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        [STAThread]
        static void Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch (Exception) { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            new Launcher(Options.Parse(args)).Run();
        }
    }

    sealed class Options
    {
        // The build folder (install-update-task.ps1 passes it); without it
        // the launcher skips the check on GitHub.
        public string Repo;
        public string StateDir;
        public string AppExe;
        public string TaskName = "LearnHarness fork update";
        public string LanguageFile;

        public static Options Parse(string[] args)
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            Options o = new Options();
            o.StateDir = Path.Combine(local, "LearnHarness-fork");
            o.AppExe = Path.Combine(local, @"Programs\learnharness\LearnHarness.exe");
            o.LanguageFile = Path.Combine(roaming, @"LearnHarness\data\language.json");
            for (int i = 0; i + 1 < args.Length; i += 2)
            {
                string value = args[i + 1];
                switch (args[i])
                {
                    case "--repo": o.Repo = value.TrimEnd('\\'); break;
                    case "--state-dir": o.StateDir = value; break;
                    case "--app": o.AppExe = value; break;
                    case "--task": o.TaskName = value; break;
                    case "--language-file": o.LanguageFile = value; break;
                }
            }
            return o;
        }
    }

    // What auto-update.ps1 records in state.json.
    sealed class State
    {
        public string Status, Origin, Version, Installer, Message, Log;
        public int Pid;
        public DateTime? Started, Finished;

        public static State Read(string file)
        {
            // auto-update.ps1 replaces the file whole; a read that races it retries.
            for (int attempt = 0; attempt < 3; attempt++)
            {
                if (!File.Exists(file)) return null;
                try
                {
                    Dictionary<string, object> json = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file)) as Dictionary<string, object>;
                    if (json == null) return null;
                    State s = new State();
                    s.Status = Text(json, "status");
                    s.Origin = Text(json, "origin");
                    s.Version = Text(json, "version");
                    s.Installer = Text(json, "installer");
                    s.Message = Text(json, "message");
                    s.Log = Text(json, "log");
                    object pid;
                    if (json.TryGetValue("pid", out pid) && pid != null) s.Pid = Convert.ToInt32(pid, CultureInfo.InvariantCulture);
                    s.Started = Time(Text(json, "started"));
                    s.Finished = Time(Text(json, "finished"));
                    return s;
                }
                catch (Exception)
                {
                    Thread.Sleep(100);
                }
            }
            return null;
        }

        static string Text(Dictionary<string, object> json, string key)
        {
            object value;
            return json.TryGetValue(key, out value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
        }

        static DateTime? Time(string value)
        {
            DateTimeOffset time;
            if (value != null && DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out time)) return time.LocalDateTime;
            return null;
        }
    }

    sealed class Texts
    {
        public string Checking, Building, BuildingDetail, Installing, InstallingDetail, Failed, FailedDetail, OpenNow, ViewLog;

        public static Texts For(string languageFile)
        {
            bool portuguese = false;
            try
            {
                Dictionary<string, object> json = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(languageFile)) as Dictionary<string, object>;
                object ui;
                portuguese = json != null && json.TryGetValue("ui", out ui) && "pt-BR".Equals(ui);
            }
            catch (Exception) { }
            Texts t = new Texts();
            if (portuguese)
            {
                t.Checking = "Procurando atualizações…";
                t.Building = "Atualizando o LearnHarness…";
                t.BuildingDetail = "Gerando a versão mais recente da main. Leva cerca de 7 minutos ({0} até agora).";
                t.Installing = "Instalando o LearnHarness {0}…";
                t.InstallingDetail = "Leva alguns segundos.";
                t.Failed = "Não foi possível atualizar o LearnHarness";
                t.FailedDetail = "{0} A versão atual foi aberta.";
                t.OpenNow = "Abrir agora";
                t.ViewLog = "Ver log";
            }
            else
            {
                t.Checking = "Checking for updates…";
                t.Building = "Updating LearnHarness…";
                t.BuildingDetail = "Building the latest version from main. This takes about 7 minutes ({0} so far).";
                t.Installing = "Installing LearnHarness {0}…";
                t.InstallingDetail = "This takes a few seconds.";
                t.Failed = "LearnHarness could not update";
                t.FailedDetail = "{0} The current version is open.";
                t.OpenNow = "Open now";
                t.ViewLog = "View log";
            }
            return t;
        }
    }

    sealed class LauncherForm : Form
    {
        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        readonly Label title = new Label();
        readonly Label detail = new Label();
        readonly Button openButton;
        readonly Button logButton;
        string logPath;

        public event EventHandler OpenNowClicked;

        public LauncherForm(Texts text, Icon icon)
        {
            Color foreground = Color.FromArgb(237, 237, 237);
            SuspendLayout();
            Text = "LearnHarness";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(23, 23, 23);
            ForeColor = foreground;
            Font = new Font("Segoe UI", 9.75f);
            if (icon != null) Icon = icon;

            title.Location = new Point(20, 18);
            title.Size = new Size(420, 28);
            title.Font = new Font("Segoe UI Semibold", 12f);
            detail.Location = new Point(20, 52);
            detail.Size = new Size(420, 62);
            detail.ForeColor = Color.FromArgb(163, 163, 163);
            openButton = MakeButton(text.OpenNow, 336, foreground);
            logButton = MakeButton(text.ViewLog, 222, foreground);
            openButton.Click += delegate { if (OpenNowClicked != null) OpenNowClicked(this, EventArgs.Empty); };
            logButton.Click += delegate
            {
                if (logPath == null) return;
                try { Process.Start(logPath); } catch (Exception) { }
            };
            Controls.AddRange(new Control[] { title, detail, openButton, logButton });
            // Sizes above are for 96 DPI; scale them to the screen.
            AutoScaleDimensions = new SizeF(96f, 96f);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(460, 168);
            ResumeLayout(false);
        }

        static Button MakeButton(string label, int x, Color foreground)
        {
            Button b = new Button();
            b.Text = label;
            b.Location = new Point(x, 122);
            b.Size = new Size(104, 30);
            b.FlatStyle = FlatStyle.Flat;
            b.BackColor = Color.FromArgb(45, 45, 45);
            b.ForeColor = foreground;
            b.FlatAppearance.BorderColor = Color.FromArgb(72, 72, 72);
            b.AccessibleRole = AccessibleRole.PushButton;
            b.Visible = false;
            return b;
        }

        public void SetContent(string titleText, string detailText, bool showOpenNow, string log)
        {
            title.Text = titleText;
            detail.Text = detailText;
            openButton.Visible = showOpenNow;
            logPath = string.IsNullOrEmpty(log) ? null : log;
            // View log takes the right-hand slot when Open now is hidden.
            logButton.Left = showOpenNow ? openButton.Left - logButton.Width - openButton.Width / 10 : openButton.Left;
            logButton.Visible = logPath != null;
        }

        // A dark title bar, like the app's (Windows 11; ignored elsewhere).
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int dark = 1;
                DwmSetWindowAttribute(Handle, 20, ref dark, 4);
            }
            catch (Exception) { }
        }
    }

    sealed class Launcher
    {
        const int TaskRunning = 4; // TASK_STATE_RUNNING

        readonly Options options;
        readonly Texts text;
        readonly string stateFile;
        readonly string appName;
        LauncherForm form;
        bool openNow;
        bool closed;

        public Launcher(Options options)
        {
            this.options = options;
            text = Texts.For(options.LanguageFile);
            stateFile = Path.Combine(options.StateDir, "state.json");
            appName = Path.GetFileNameWithoutExtension(options.AppExe);
        }

        public void Run()
        {
            bool launch = true;
            try { launch = Decide(); }
            catch (Exception e) { Log(e.ToString()); }
            if (launch) StartApp();
            if (form != null)
            {
                form.Close();
                form.Dispose();
            }
        }

        // Waits and installs as needed; returns whether to open the app.
        bool Decide()
        {
            if (AppRunning()) return true; // starting it again brings it forward
            DateTime clicked = DateTime.Now;
            string remote = RemoteMain();
            DateTime? lastTrigger = null;
            int triggers = 0;
            while (true)
            {
                if (closed) return false;
                if (openNow) return true;
                State state = State.Read(stateFile);
                if (state != null && state.Status == "building" && ProcessAlive(state.Pid))
                {
                    DateTime since = state.Started ?? clicked;
                    int seconds = Math.Max(0, (int)(DateTime.Now - since).TotalSeconds);
                    string elapsed = string.Format(CultureInfo.InvariantCulture, "{0}:{1:00}", seconds / 60, seconds % 60);
                    ShowWindow(text.Building, string.Format(text.BuildingDetail, elapsed), true, null);
                    Wait(1000);
                    continue;
                }
                if (remote != null && (state == null || state.Origin != remote))
                {
                    DateTime? finished = state != null ? state.Finished : null;
                    if (lastTrigger.HasValue && finished.HasValue && finished.Value > lastTrigger.Value)
                    {
                        // A run finished since the click; main may have moved during it.
                        remote = RemoteMain();
                        lastTrigger = null;
                        triggers = 0;
                        continue;
                    }
                    int taskState = TaskState();
                    if (taskState < 0) break; // no update task: open what is installed
                    if (taskState != TaskRunning)
                    {
                        // A run already going when main moved may have fetched before it.
                        if (triggers >= 3) break;
                        if (!lastTrigger.HasValue || (DateTime.Now - lastTrigger.Value).TotalSeconds >= 10)
                        {
                            RunTask();
                            lastTrigger = DateTime.Now;
                            triggers++;
                        }
                    }
                    if ((DateTime.Now - clicked).TotalSeconds >= 1.5) ShowWindow(text.Checking, "", true, null);
                    Wait(500);
                    continue;
                }
                break;
            }

            State last = State.Read(stateFile);
            if (last != null && last.Status == "failed" && (remote == null || last.Origin == remote))
            {
                StartApp();
                ShowWindow(text.Failed, string.Format(text.FailedDetail, last.Message), false, last.Log);
                Wait(8000);
                return false;
            }
            if (last != null && !string.IsNullOrEmpty(last.Installer) && File.Exists(last.Installer) && !AppRunning())
            {
                Version ready = ParseVersion(last.Version);
                Version installed = File.Exists(options.AppExe) ? ParseVersion(FileVersionInfo.GetVersionInfo(options.AppExe).ProductVersion) : null;
                if (ready != null && (installed == null || ready > installed)) Install(last);
            }
            return true;
        }

        void Install(State state)
        {
            ShowWindow(string.Format(text.Installing, state.Version), text.InstallingDetail, false, null);
            form.ControlBox = false;
            // Run a copy: a build starting meanwhile empties dist\.
            string setup = Path.Combine(Path.GetTempPath(), "LearnHarness-fork-setup.exe");
            File.Copy(state.Installer, setup, true);
            // The installer keeps the desktop shortcut (KeepShortcuts) and
            // does not start the app when silent.
            ProcessStartInfo info = new ProcessStartInfo(setup, "/S");
            info.UseShellExecute = false;
            using (Process process = Process.Start(info))
            {
                while (!process.HasExited)
                {
                    Application.DoEvents();
                    Thread.Sleep(100);
                }
                if (process.ExitCode != 0) Log("The installer " + state.Installer + " exited with code " + process.ExitCode + ".");
            }
            try { File.Delete(setup); } catch (Exception) { }
        }

        void ShowWindow(string title, string detail, bool showOpenNow, string log)
        {
            if (form == null)
            {
                Icon icon = null;
                try { icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
                form = new LauncherForm(text, icon);
                form.OpenNowClicked += delegate { openNow = true; };
                form.FormClosed += delegate { closed = true; };
                form.SetContent(title, detail, showOpenNow, log);
                form.Show();
                form.Activate();
            }
            else
            {
                form.SetContent(title, detail, showOpenNow, log);
            }
            Application.DoEvents();
        }

        void Wait(int milliseconds)
        {
            DateTime until = DateTime.Now.AddMilliseconds(milliseconds);
            while (DateTime.Now < until && !openNow && !closed)
            {
                Application.DoEvents();
                Thread.Sleep(50);
            }
        }

        bool AppRunning()
        {
            Process[] processes = Process.GetProcessesByName(appName);
            foreach (Process p in processes) p.Dispose();
            return processes.Length > 0;
        }

        void StartApp()
        {
            try
            {
                if (!File.Exists(options.AppExe)) return;
                ProcessStartInfo info = new ProcessStartInfo(options.AppExe);
                info.WorkingDirectory = Path.GetDirectoryName(options.AppExe);
                info.UseShellExecute = true;
                Process.Start(info);
            }
            catch (Exception e)
            {
                Log("Could not open the app: " + e.Message);
            }
        }

        string RemoteMain()
        {
            if (string.IsNullOrEmpty(options.Repo) || !Directory.Exists(options.Repo)) return null;
            try
            {
                ProcessStartInfo info = new ProcessStartInfo("git.exe", "-C \"" + options.Repo + "\" ls-remote origin refs/heads/main");
                info.UseShellExecute = false;
                info.RedirectStandardOutput = true;
                info.CreateNoWindow = true;
                info.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";
                info.EnvironmentVariables["GCM_INTERACTIVE"] = "never";
                using (Process process = Process.Start(info))
                {
                    System.Threading.Tasks.Task<string> output = process.StandardOutput.ReadToEndAsync();
                    if (!process.WaitForExit(6000))
                    {
                        try { process.Kill(); } catch (Exception) { }
                        return null;
                    }
                    Match match = Regex.Match(output.Result, "^([0-9a-f]{40})\\s");
                    return process.ExitCode == 0 && match.Success ? match.Groups[1].Value : null;
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        // The update task's state, or -1 when it does not exist.
        int TaskState()
        {
            try
            {
                dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
                service.Connect();
                dynamic task = service.GetFolder("\\").GetTask(options.TaskName);
                return (int)task.State;
            }
            catch (Exception)
            {
                return -1;
            }
        }

        void RunTask()
        {
            try
            {
                dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
                service.Connect();
                dynamic task = service.GetFolder("\\").GetTask(options.TaskName);
                task.Run(null);
            }
            catch (Exception e)
            {
                Log("Could not start the update task: " + e.Message);
            }
        }

        static bool ProcessAlive(int pid)
        {
            if (pid <= 0) return false;
            try
            {
                using (Process.GetProcessById(pid)) return true;
            }
            catch (ArgumentException)
            {
                return false;
            }
        }

        static Version ParseVersion(string value)
        {
            if (value == null) return null;
            Match m = Regex.Match(value, "^(\\d+)\\.(\\d+)\\.(\\d+)");
            if (!m.Success) return null;
            return new Version(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value));
        }

        void Log(string message)
        {
            try
            {
                string dir = Path.Combine(options.StateDir, "logs");
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "launcher.log"), "[" + DateTime.Now.ToString("o") + "] " + message + Environment.NewLine);
            }
            catch (Exception) { }
        }
    }
}
