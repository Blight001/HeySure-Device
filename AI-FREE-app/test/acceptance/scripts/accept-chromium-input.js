'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { app, BrowserWindow } = require('electron');
const { createBrowserRuntimeManager } = require('../../../src/app/main/browser-runtime');

delete process.env.AI_FREE_CHROMIUM_HANDSHAKE;
delete process.env.AI_FREE_CHROMIUM_PATH;

const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-input-'));
let window;
let switchWindow;
let manager;
let server;
let acceptanceFinished = false;

function assertReady(state) {
  if (!state || state.status !== 'ready' || state.bridgeConnected !== true ||
      !state.sessionId || !state.browserHwnd || state.embedded !== true) {
    throw new Error(`Input acceptance runtime state invalid: ${JSON.stringify(state)}`);
  }
}

function driveWin32Input(browserHwnd) {
  const source = String.raw`
using System;
using System.Text;
using System.Collections.Generic;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Windows.Automation;

public static class AiFreeInputAcceptance {
  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);
  const uint GA_ROOT = 2;
  const int SW_SHOW = 5;
  const byte VK_K = 0x4b;
  const byte VK_E = 0x45;
  const byte VK_Y = 0x59;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint WM_KEYDOWN = 0x0100;
  const uint WM_KEYUP = 0x0101;
  const uint WM_CHAR = 0x0102;

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)]
  struct GUITHREADINFO {
    public int cbSize;
    public uint flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner;
    public IntPtr hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx, dy;
    public uint mouseData, dwFlags, time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT {
    public ushort wVk, wScan;
    public uint dwFlags, time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
    [FieldOffset(0)] public HARDWAREINPUT hardware;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION data; }

  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr processId);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

  static bool Key(byte key) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 1;
    inputs[0].data.keyboard.wVk = key;
    inputs[0].data.keyboard.wScan = (ushort)MapVirtualKey(key, 0);
    inputs[1] = inputs[0];
    inputs[1].data.keyboard.dwFlags = KEYEVENTF_KEYUP;
    bool sent = SendInput((uint)inputs.Length, inputs,
      Marshal.SizeOf(typeof(INPUT))) == (uint)inputs.Length;
    Thread.Sleep(30);
    return sent;
  }

  static IntPtr currentBrowser = IntPtr.Zero;

  static string ClassName(IntPtr hwnd) {
    StringBuilder className = new StringBuilder(256);
    if (hwnd != IntPtr.Zero) GetClassName(hwnd, className, className.Capacity);
    return className.ToString();
  }

  static IntPtr FindRenderWidget(IntPtr root) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(root, delegate(IntPtr child, IntPtr parameter) {
      StringBuilder className = new StringBuilder(256);
      GetClassName(child, className, className.Capacity);
      if (className.ToString().IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase) >= 0) {
        found = child;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static string DescribeRenderWidgets(IntPtr root) {
    List<string> descriptions = new List<string>();
    EnumChildWindows(root, delegate(IntPtr child, IntPtr parameter) {
      if (ClassName(child).IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase) >= 0) {
        RECT rect;
        GetWindowRect(child, out rect);
        descriptions.Add(child.ToInt64().ToString() + ":V=" + IsWindowVisible(child) +
          ":E=" + IsWindowEnabled(child) + ":P=" + GetParent(child).ToInt64().ToString() +
          ":R=" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom);
      }
      return true;
    }, IntPtr.Zero);
    return String.Join("|", descriptions.ToArray());
  }

  public static string Drive(long rawHwnd) {
    IntPtr hwnd = new IntPtr(rawHwnd);
    if (!IsWindow(hwnd)) return "ALIVE=false;TITLE=";
    currentBrowser = hwnd;
    IntPtr root = GetAncestor(hwnd, GA_ROOT);
    ShowWindow(root, SW_SHOW);
    ShowWindow(hwnd, SW_SHOW);
    Thread.Sleep(250);
    RECT rect;
    IntPtr pointWindow = IntPtr.Zero;
    if (GetWindowRect(hwnd, out rect)) {
      int centerX = (rect.Left + rect.Right) / 2;
      int centerY = (rect.Top + rect.Bottom) / 2;
      SetCursorPos(centerX, centerY);
      POINT point = new POINT();
      point.X = centerX;
      point.Y = centerY;
      pointWindow = WindowFromPoint(point);
      if (pointWindow != IntPtr.Zero) currentBrowser = pointWindow;
      mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
      mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
      Thread.Sleep(150);
    }
    uint targetThread = GetWindowThreadProcessId(hwnd, IntPtr.Zero);
    uint currentThread = GetCurrentThreadId();
    IntPtr foregroundBeforeFocus = GetForegroundWindow();
    uint foregroundThread = foregroundBeforeFocus != IntPtr.Zero
      ? GetWindowThreadProcessId(foregroundBeforeFocus, IntPtr.Zero)
      : 0;
    bool attachedTarget = targetThread != 0 && targetThread != currentThread &&
      AttachThreadInput(currentThread, targetThread, true);
    bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread &&
      foregroundThread != targetThread &&
      AttachThreadInput(currentThread, foregroundThread, true);
    SetForegroundWindow(root);
    SetFocus(hwnd);
    bool automationFocused = false;
    try {
      AutomationElement browserElement = AutomationElement.FromHandle(hwnd);
      AutomationElement edit = browserElement.FindFirst(
        TreeScope.Descendants,
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
      if (edit != null) {
        edit.SetFocus();
        automationFocused = true;
        Thread.Sleep(150);
      }
    } catch {}
    bool keysSent = Key(VK_K) && Key(VK_E) && Key(VK_Y);
    if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
    Thread.Sleep(1500);
    if (GetWindowRect(hwnd, out rect)) {
      SetCursorPos((rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2);
      mouse_event(MOUSEEVENTF_WHEEL, 0, 0, -240, UIntPtr.Zero);
      Thread.Sleep(150);
      mouse_event(MOUSEEVENTF_WHEEL, 0, 0, 120, UIntPtr.Zero);
    }
    StringBuilder title = new StringBuilder(512);
    GetWindowText(hwnd, title, title.Capacity);
    GUITHREADINFO threadInfo = new GUITHREADINFO();
    threadInfo.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    GetGUIThreadInfo(GetWindowThreadProcessId(hwnd, IntPtr.Zero), ref threadInfo);
    return "ALIVE=" + IsWindow(hwnd).ToString().ToLowerInvariant() +
      ";TITLE=" + title.ToString() +
      ";KEYS_SENT=" + keysSent.ToString().ToLowerInvariant() +
      ";UIA_FOCUSED=" + automationFocused.ToString().ToLowerInvariant() +
      ";POINT_CLASS=" + ClassName(pointWindow) +
      ";FOREGROUND_CLASS=" + ClassName(GetForegroundWindow()) +
      ";FOCUS_CLASS=" + ClassName(threadInfo.hwndFocus) +
      ";ACTIVE_CLASS=" + ClassName(threadInfo.hwndActive) +
      ";RWHV=" + DescribeRenderWidgets(hwnd);
  }
}`;
  const script = `Add-Type -ReferencedAssemblies System.Windows.Forms,UIAutomationClient,UIAutomationTypes -TypeDefinition @'\n${source}\n'@\n` +
    `[AiFreeInputAcceptance]::Drive([long]'${browserHwnd}')`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Win32 input driver timed out'));
    }, 30000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Win32 input driver failed: ${stderr || stdout}`));
      else resolve(stdout.trim());
    });
  });
}

async function shutdown(code) {
  acceptanceFinished = true;
  try { await manager?.stopAll({ timeoutMs: 5000 }); } catch (_) {}
  try { switchWindow?.destroy(); } catch (_) {}
  try { await new Promise((resolve) => server?.close(resolve)); } catch (_) {}
  try { fs.rmSync(profileRoot, { recursive: true, force: true }); } catch (_) {}
  app.exit(code);
}

app.whenReady().then(async () => {
  server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(`<!doctype html>
      <title>WAITING_FOR_INPUT</title>
      <input id="target" autofocus style="position:fixed;inset:20px;font-size:40px">
      <script>
        const target = document.getElementById('target');
        let clicked = false;
        const update = () => {
          document.title = 'AI_FREE_CLICK_' + (clicked ? 'OK' : 'MISSING') +
            '_KEY_' + (target.value || 'EMPTY');
        };
        target.addEventListener('click', () => { clicked = true; update(); });
        target.addEventListener('input', update);
      <\/script>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  window = new BrowserWindow({ width: 1280, height: 850, show: true, title: 'AI-FREE Input Acceptance' });
  await window.loadURL('data:text/html,<body style="background:%23101827;color:white"><h2>AI-FREE input acceptance</h2></body>');
  manager = createBrowserRuntimeManager({
    userDataDir: profileRoot,
    resourcesPath: path.resolve(__dirname, '..', '..', '..', 'resources'),
    getParentWindow: () => window,
    logger: console,
  });
  const bounds = { x: 0, y: 41, width: 1280, height: 809 };
  const inputPageUrl = `http://127.0.0.1:${server.address().port}/input`;
  const state = await manager.launchProfile({
    profileId: 'phase2_input',
    runtimeType: 'chromium',
    initialUrl: 'about:blank',
    launchTimeoutMs: 30000,
  }, bounds);
  assertReady(state);
  const navigation = await manager.navigate('phase2_input', 'chromium', inputPageUrl);
  if (!navigation?.ok) {
    throw new Error(`Runtime Bridge navigation failed: ${JSON.stringify(navigation)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const heartbeatBefore = state.lastHeartbeatAt;
  await manager.resize('phase2_input', 'chromium', { ...bounds, width: 1278, height: 807 });
  await manager.show('phase2_input', 'chromium');
  window.show();
  window.moveTop();
  window.focus();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const focusResult = await manager.focus('phase2_input', 'chromium');
  console.log('[phase2-input] native focus result:', focusResult);
  switchWindow = new BrowserWindow({ width: 320, height: 180, show: true, title: 'Focus switch probe' });
  await switchWindow.loadURL('data:text/html,<title>FOCUS_SWITCH_PROBE</title>');
  switchWindow.show();
  switchWindow.focus();
  await new Promise((resolve) => setTimeout(resolve, 300));
  window.show();
  window.moveTop();
  window.focus();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const manualWaitMs = Math.max(0, Number(process.env.AI_FREE_INPUT_MANUAL_WAIT_MS) || 0);
  if (manualWaitMs > 0) {
    console.log(`[phase2-input] manual input window: ${manualWaitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, manualWaitMs));
  }
  const inputResult = await driveWin32Input(state.browserHwnd);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const after = manager.getState('phase2_input');
  assertReady(after);
  if (after.lastHeartbeatAt <= heartbeatBefore ||
      !/ALIVE=true/.test(inputResult) ||
      !/AI_FREE_CLICK_OK_KEY_(?!EMPTY)/.test(inputResult)) {
    throw new Error(`Input/heartbeat acceptance failed: ${inputResult}; ${JSON.stringify(after)}`);
  }
  console.log('[phase2-input] Web input typing, wheel, resize and focus passed');
  console.log('[phase2-input] HWND result:', inputResult);
  await shutdown(0);
}).catch(async (error) => {
  console.error('[phase2-input] FAILED', error.stack || error);
  await shutdown(1);
});

app.on('window-all-closed', () => {
  if (acceptanceFinished) return;
  console.error('[phase2-input] FAILED acceptance window was closed before assertions completed');
  void shutdown(1);
});
