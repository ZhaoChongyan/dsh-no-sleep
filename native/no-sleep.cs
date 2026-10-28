// Native helpers for the DeepSeek Harness "no sleep" plugin.
//
// Built by `build.ps1` into %USERPROFILE%\.dsh\lib\native\no-sleep.dll, which the
// plugin's Host half loads in-process. KeepAwake.NoSleep is the entry point; the
// other type is internal support.
//
// Sleep inhibition uses SetThreadExecutionState from a PRIVATE background thread.
// That call is cumulative per process (every thread that asks for ES_CONTINUOUS
// keeps the system awake until that thread asks again without it), so holding it
// on our own thread leaves the rest of the Harness process untouched, and the
// thread is a background thread: it can never keep the process alive. When the
// Host exits, including on a crash, Windows drops the request with the process.
//
// Reporting is about what Windows CONFIRMS, not about the plugin's intention:
//   * SetThreadExecutionState's return value is the previous state of the calling
//     thread and is meaningful only on that thread, so the holder thread re-asserts
//     the request on every poll and records the value it got back;
//   * `sessionLocked` comes from the input desktop, which Windows swaps for the
//     secure desktop while locked, and `idleSeconds` from the session idle timer.
//     A request that is honored keeps the user's input alive, so a locked session
//     with a climbing idle time means the request is not taking effect, while a
//     locked session whose idle time stays near zero does (by design).
//
// Required-layout structs: never switch them to auto layout.
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace KeepAwake
{
    public static class NoSleep
    {
        const uint StateSystemRequired = 0x00000001;
        const uint StateDisplayRequired = 0x00000002;
        const uint StateContinuous = 0x80000000;

        const int ModeNone = 0;
        const int ModeSystem = 1;
        const int ModeDisplay = 2;

        static readonly object Sync = new object();
        static Thread loop;
        static volatile bool stopping;
        static volatile int mode = ModeNone;
        static int SelfMode;

        // Written by the holder thread, read by Query(): "what did Windows answer".
        static volatile uint lastSetReturn;
        static volatile int lastSetError;
        static long lastAssertTicks;
        static volatile string lastFailure = "";

        // ---- entry points -------------------------------------------------

        /// <summary>
        /// Hold the requested execution state from a dedicated thread.
        /// <paramref name="mode"/>: "display" (screen and system) or "system" (system
        /// only). Returns "" on success, otherwise a diagnostic message. Idempotent.
        /// </summary>
        public static string Begin(string requestedMode, string reason)
        {
            int wanted = IsDisplayMode(requestedMode) ? ModeDisplay : ModeSystem;
            lock (Sync)
            {
                if (loop != null && loop.IsAlive && SelfMode == wanted) return "";
                if (loop != null && loop.IsAlive)
                {
                    // Changing mode: clear the old hold first, then start the new one.
                    StopLocked();
                }
                stopping = false;
                SelfMode = wanted;
                lastFailure = "";
                lastAssertTicks = 0;
                lastSetReturn = 0;
                lastSetError = 0;
                SampleIdle(out _, out _);
                var thread = new Thread(Loop)
                {
                    IsBackground = true,
                    Priority = ThreadPriority.BelowNormal,
                    Name = wanted == ModeDisplay ? "dsh-no-sleep/display" : "dsh-no-sleep/system",
                };
                thread.Start(wanted);
                loop = thread;
                for (int i = 0; i < 400 && mode != wanted; i++)
                {
                    if (!thread.IsAlive && mode != wanted) break;
                    Thread.Sleep(5);
                }
                if (mode != wanted)
                {
                    return string.IsNullOrEmpty(lastFailure)
                        ? "the keep-awake thread did not start"
                        : lastFailure;
                }
                return "";
            }
        }

        /// <summary>Release everything; returns "" once the thread has ended.</summary>
        public static string End(string reason)
        {
            Thread thread;
            lock (Sync)
            {
                thread = StopLocked();
            }
            if (thread == null) return "";
            try
            {
                if (!thread.Join(3000)) return "the keep-awake thread has not stopped yet";
            }
            catch (Exception error)
            {
                return Describe(error, "could not join the keep-awake thread");
            }
            return "";
        }

        static Thread StopLocked()
        {
            var thread = loop;
            loop = null;
            SelfMode = ModeNone;
            stopping = true;
            return thread;
        }

        /// <summary>
        /// Snapshot for the settings row, as JSON. `active` means the holder thread is
        /// live and its last request succeeded; `confirmed` means the session also
        /// shows the effects Windows produces while such a request is honored.
        /// </summary>
        public static string Query()
        {
            int current = mode;
            Thread holder = loop;
            bool threadLive = current != ModeNone && holder != null && holder.IsAlive;
            bool active = threadLive && lastSetError == 0 && lastSetReturn != 0;
            bool sessionLocked = !NativeWindows.CanOpenInputDesktop();
            uint idle;
            bool idleKnown = SampleIdle(out idle, out _);
            long assertAge = lastAssertTicks == 0 ? -1
                : (long)Math.Round((DateTime.UtcNow.Ticks - lastAssertTicks) / 10000.0);
            // Evidence table, mirrored in locale/*.json ("verify.*"):
            //   active              the holder thread's last SetThreadExecutionState
            //                       returned a non-zero previous state;
            //   confirmed + unlocked the input desktop is open, so Windows is showing
            //                       the user's own session: the hold is effective;
            //   confirmed + locked   the secure desktop is up. A system hold updates
            //                       the lock-screen idle time to keep the "require
            //                       sign-in" timer away; an achieved display hold has
            //                       sent the display to sleep, which stops those updates.
            //                       Observing an idle time at most 30 s old therefore
            //                       means the system hold is live and the display
            //                       really went dark. A display hold that shows no recent
            //                       activity cannot be settled from here (a 60 s screen
            //                       timeout makes that window narrow), so it is reported
            //                       as confirmed: the unlock state is the final check.
            bool confirmed = active && (!sessionLocked
                || (idleKnown && (current == ModeDisplay || idle <= 30)));
            var json = new StringBuilder(256);
            json.Append("{\"supported\":true");
            json.Append(",\"active\":").Append(active ? "true" : "false");
            json.Append(",\"confirmed\":").Append(confirmed ? "true" : "false");
            json.Append(",\"mode\":\"").Append(active ? (current == ModeDisplay ? "display" : "system") : "none").Append('"');
            json.Append(",\"pid\":").Append(Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
            json.Append(",\"threadLive\":").Append(threadLive ? "true" : "false");
            json.Append(",\"lastAssertAgeMs\":").Append(assertAge.ToString(CultureInfo.InvariantCulture));
            json.Append(",\"lastSetReturn\":").Append(lastSetReturn.ToString(CultureInfo.InvariantCulture));
            json.Append(",\"lastSetError\":").Append(lastSetError.ToString(CultureInfo.InvariantCulture));
            json.Append(",\"failure\":").Append(JsonString(lastFailure));
            json.Append(",\"sessionLocked\":").Append(sessionLocked ? "true" : "false");
            json.Append(",\"idleSeconds\":").Append(idle.ToString(CultureInfo.InvariantCulture));
            json.Append(",\"idleKnown\":").Append(idleKnown ? "true" : "false");
            json.Append(",\"foreground\":false");
            json.Append('}');
            return json.ToString();
        }

        static string JsonString(string value)
        {
            if (string.IsNullOrEmpty(value)) return "\"\"";
            var escaped = new StringBuilder(value.Length + 8);
            escaped.Append('"');
            foreach (var c in value)
            {
                switch (c)
                {
                    case '"': escaped.Append("\\\""); break;
                    case '\\': escaped.Append("\\\\"); break;
                    case '\n': escaped.Append("\\n"); break;
                    case '\r': escaped.Append("\\r"); break;
                    case '\t': escaped.Append("\\t"); break;
                    default:
                        if (c < 0x20) escaped.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else escaped.Append(c);
                        break;
                }
            }
            escaped.Append('"');
            return escaped.ToString();
        }

        /// <summary>Diagnostic report: what this process sees on its own threads.</summary>
        public static string Probe()
        {
            var report = new StringBuilder();
            report.Append("query=").Append(Query());
            try
            {
                uint previous = SetThreadExecutionState(StateContinuous | StateSystemRequired);
                int error = Marshal.GetLastWin32Error();
                uint previousAgain = SetThreadExecutionState(StateContinuous);
                uint cleared = SetThreadExecutionState(0);
                report.Append(" selfSetPrevious=").Append(previous.ToString(CultureInfo.InvariantCulture));
                report.Append(" selfSetError=").Append(error.ToString(CultureInfo.InvariantCulture));
                report.Append(" selfSecondPrevious=").Append(previousAgain.ToString(CultureInfo.InvariantCulture));
                report.Append(" selfCleared=").Append(cleared.ToString(CultureInfo.InvariantCulture));
                report.Append(" consoleSession=").Append(NativeWindows.IsConsoleSession() ? "true" : "false");
                report.Append(" desktopOpenable=").Append(NativeWindows.CanOpenInputDesktop() ? "true" : "false");
            }
            catch (Exception error)
            {
                report.Append(" selfError=").Append(Describe(error, "probe"));
            }
            return report.ToString();
        }

        // ---- the holder thread -------------------------------------------

        static void Loop(object arg)
        {
            int wanted = (int)arg;
            uint flags = StateContinuous | StateSystemRequired
                | (wanted == ModeDisplay ? StateDisplayRequired : 0);
            try
            {
                // First request: its return value already carries any live hold that
                // another holder thread left behind, so it can prove success by itself.
                uint early = SetThreadExecutionState(flags);
                lastSetError = Marshal.GetLastWin32Error();
                if (early != 0)
                {
                    lastSetReturn = early;
                    lastAssertTicks = DateTime.UtcNow.Ticks;
                    mode = wanted;
                }
                while (!stopping)
                {
                    if (early == 0 || stopping)
                    {
                        // Retry (or keep going) on every poll: the call is cheap and
                        // the return value is the only confirmation Windows offers.
                        uint value = SetThreadExecutionState(flags);
                        if (value != 0)
                        {
                            lastSetReturn = value;
                            lastSetError = 0;
                            lastAssertTicks = DateTime.UtcNow.Ticks;
                            mode = wanted;
                        }
                        else
                        {
                            lastSetError = Marshal.GetLastWin32Error();
                            mode = ModeNone;
                        }
                    }
                    for (int i = 0; i < 10 && !stopping; i++) Thread.Sleep(500);
                }
            }
            catch (Exception error)
            {
                try { lastFailure = Describe(error, "keep-awake thread failed"); } catch { }
                mode = ModeNone;
            }
            finally
            {
                mode = ModeNone;
                try { SetThreadExecutionState(0); } catch { }
            }
        }

        /// <summary>Read the console session's idle timer; false when unavailable.</summary>
        static bool SampleIdle(out uint seconds, out long ticks)
        {
            seconds = 0;
            ticks = 0;
            try
            {
                IntPtr buffer;
                int bytes;
                if (!NativeWindows.QuerySessionInfo(-1, 8 /* WTSIdleTime */, out buffer, out bytes)) return false;
                try
                {
                    if (bytes >= 8)
                    {
                        long raw = System.Runtime.InteropServices.Marshal.ReadInt64(buffer);
                        seconds = (uint)(raw / 10000000L);
                        ticks = DateTime.UtcNow.Ticks;
                        return true;
                    }
                    return false;
                }
                finally
                {
                    NativeWindows.FreeSessionInfo(buffer);
                }
            }
            catch
            {
                return false;
            }
        }

        // ---- helpers -----------------------------------------------------

        static bool IsDisplayMode(string mode)
        {
            return !string.IsNullOrEmpty(mode)
                && mode.Trim().Equals("display", StringComparison.OrdinalIgnoreCase);
        }

        static string Describe(Exception error, string fallback)
        {
            try { return fallback + ": " + error.GetType().Name + ": " + error.Message; }
            catch { return fallback; }
        }

        // ---- Win32 -------------------------------------------------------

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint SetThreadExecutionState(uint flags);

        /// <summary>
        /// Make this process unattached from the calling thread's console, so a helper
        /// process started by the Harness does not end when the Console window closes.
        /// </summary>
        public static void DetachFromConsole()
        {
            try
            {
                FreeConsole();
            }
            catch
            {
                // Without a console there is nothing to detach from.
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool FreeConsole();
    }

    /// <summary>Session and desktop queries used by the settings row.</summary>
    internal static class NativeWindows
    {
        [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool WTSQuerySessionInformationW(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);

        [DllImport("wtsapi32.dll")]
        static extern void WTSFreeMemory(IntPtr memory);

        [DllImport("kernel32.dll")]
        static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

        [DllImport("user32.dll")]
        static extern bool CloseDesktop(IntPtr desktop);

        /// <summary>Thin wrapper so NoSleep can free the WTS buffer it read.</summary>
        public static bool QuerySessionInfo(int sessionId, int infoClass, out IntPtr buffer, out int bytes)
        {
            return WTSQuerySessionInformationW(IntPtr.Zero, sessionId, infoClass, out buffer, out bytes);
        }

        public static void FreeSessionInfo(IntPtr buffer)
        {
            if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
        }

        /// <summary>True when this process runs in the session currently at the console.</summary>
        public static bool IsConsoleSession()
        {
            try
            {
                uint session;
                if (!ProcessIdToSessionId((uint)Environment.ProcessId, out session)) return false;
                return session == WTSGetActiveConsoleSessionId();
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// True when the interactive desktop can be opened. Windows replaces the input
        /// desktop with the secure one while the session is locked, so a false result
        /// from the user's own session means "locked".
        /// </summary>
        public static bool CanOpenInputDesktop()
        {
            try
            {
                var desktop = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
                if (desktop == IntPtr.Zero) return false;
                CloseDesktop(desktop);
                return true;
            }
            catch
            {
                return false;
            }
        }
    }
}
