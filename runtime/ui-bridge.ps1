param([ValidateSet('diagnose', 'probe', 'send')][string]$Mode = 'probe')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TfoUnicodeInput {
  [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput {
    public ushort virtualKey, scanCode;
    public uint flags, time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput {
    public int x, y;
    public uint data, flags, time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] public struct InputData {
    [FieldOffset(0)] public KeyboardInput keyboard;
    [FieldOffset(0)] public MouseInput mouse;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Input {
    public uint type;
    public InputData data;
  }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  public static void Type(string text) {
    var inputs = new Input[text.Length * 2];
    for (int i = 0; i < text.Length; i++) {
      inputs[2*i].type = 1; inputs[2*i].data.keyboard.scanCode = text[i]; inputs[2*i].data.keyboard.flags = 4;
      inputs[2*i+1].type = 1; inputs[2*i+1].data.keyboard.scanCode = text[i]; inputs[2*i+1].data.keyboard.flags = 6;
    }
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
    if (sent != inputs.Length) throw new InvalidOperationException("Windows did not accept all text input events");
  }
}
'@

function Read-TfoRequestJson {
  # Node writes UTF-8 bytes. Console.In can inherit the Windows OEM code page.
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8, $false)
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputJson = Read-TfoRequestJson
$request = ConvertFrom-Json -InputObject $inputJson
if ($Mode -ne 'diagnose' -and (-not $request.runId -or $request.runId -notmatch '^(chat|queue|flow)_[a-z0-9_]+$')) { throw 'Invalid TFO route marker' }
if ($request.runId -match '^flow_' -and
    (-not $request.marker -or $request.marker -ne "TFO_MAIN_JOIN $($request.runId) $($request.threadId)")) {
  throw 'Invalid selected join marker or target chat'
}
$marker = if ($request.runId -match '^flow_') { [string]$request.marker } else { [string]$request.runId }

function Get-Items($window) {
  return $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}
function Find-One($items, [string]$name, $type) {
  $matchingControls = @()
  foreach ($item in $items) {
    if ($item.Current.Name -eq $name -and $item.Current.ControlType -eq $type) { $matchingControls += $item }
  }
  if ($matchingControls.Count -ne 1) { throw "Expected one $name control, found $($matchingControls.Count)" }
  return $matchingControls[0]
}
function Find-Selector($items) {
  $matchingControls = @()
  foreach ($item in $items) {
    if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        $item.Current.Name -match '^GPT-(6\.1|6|5\.6|5\.5) ' -and $item.Current.BoundingRectangle.Width -gt 0) { $matchingControls += $item }
  }
  if ($matchingControls.Count -ne 1) { throw "Expected one model selector, found $($matchingControls.Count)" }
  return $matchingControls[0]
}
function Test-RequestedSelection([string]$label, [string]$modelLabel, [string]$effort) {
  $names = @{ low = @('Ligero','Bajo','Light','Low'); medium = @('Medio','Medium'); high = @('Alto','High');
    xhigh = @('Muy alto','Very high','Extra high'); max = @('Máximo','Max'); ultra = @('Ultra') }
  foreach ($name in $names[$effort]) {
    if ($label.Trim().Equals("$modelLabel $name", [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}
function Test-PickerOpen($items) {
  foreach ($item in $items) {
    if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem -and
        -not $item.Current.IsOffscreen -and $item.Current.Name -in @('Potencia', 'Seleccionar modelo')) { return $true }
  }
  return $false
}
function Send-PickerEscape($window) {
  Assert-RoutePendingDispatch
  if ([TfoUnicodeInput]::GetForegroundWindow() -ne [IntPtr]$window.Current.NativeWindowHandle) { throw 'Focus changed before closing the model picker' }
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
}
function Close-ModelPicker($window) {
  # Selection changes recreate the trigger. Never collapse a stale AutomationElement.
  $items = Get-Items $window
  if (Test-PickerOpen $items) { Send-PickerEscape $window }
  for ($read = 0; $read -lt 15; $read++) {
    $items = Get-Items $window
    if (-not (Test-PickerOpen $items)) {
      try { $null = Find-Selector $items; return } catch { }
    }
    Start-Sleep -Milliseconds 100
  }
  throw 'Model picker did not close and restore the composer; no prompt was entered'
}
function Get-EditorValue($items) {
  $editor = Find-One $items 'Trabaja con ChatGPT' ([System.Windows.Automation.ControlType]::Edit)
  $pattern = $editor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  return @{ element = $editor; pattern = $pattern; value = $pattern.Current.Value }
}
function Get-UiProbe($window, $items, [string]$marker) {
  $bounds = $window.Current.BoundingRectangle
  $markers = @($items | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $_.Current.Name.Contains($marker)
  })
  $visible = @($markers | Where-Object {
    $rect = $_.Current.BoundingRectangle
    -not $_.Current.IsOffscreen -and $rect.Width -gt 0 -and $rect.Height -gt 0 -and
    $rect.Bottom -gt $bounds.Top -and $rect.Top -lt $bounds.Bottom -and
    $rect.Right -gt $bounds.Left -and $rect.Left -lt $bounds.Right
  })
  if ($visible.Count -eq 0) {
    return @{ status = 'awaiting_render'; reason = 'route_marker_not_visible'; markerCount = $markers.Count;
      markerVisible = $false; readOnly = $true }
  }
  $editor = Assert-Ready $window $items $marker
  $selector = Find-Selector $items
  $editorBounds = $editor.element.Current.BoundingRectangle
  $selectorBounds = $selector.Current.BoundingRectangle
  if ($editor.element.Current.IsOffscreen -or $editorBounds.Width -le 0 -or $editorBounds.Height -le 0 -or
      $editorBounds.Top -lt $bounds.Top -or $editorBounds.Bottom -gt $bounds.Bottom -or
      $selector.Current.IsOffscreen -or $selectorBounds.Width -le 0 -or $selectorBounds.Height -le 0) {
    return @{ status = 'awaiting_render'; reason = 'composer_not_visible'; markerVisible = $true; readOnly = $true }
  }
  $markerBounds = $visible[0].Current.BoundingRectangle
  return @{ status = 'ready'; selector = $selector.Current.Name; editorEmpty = $true; readOnly = $true;
    layout = @{
      window = @($bounds.X,$bounds.Y,$bounds.Width,$bounds.Height);
      marker = @($markerBounds.X,$markerBounds.Y,$markerBounds.Width,$markerBounds.Height);
      editor = @($editorBounds.X,$editorBounds.Y,$editorBounds.Width,$editorBounds.Height);
      selector = @($selectorBounds.X,$selectorBounds.Y,$selectorBounds.Width,$selectorBounds.Height)
    }
  }
}
function Assert-ChatReady($items, [string]$marker) {
  $found = $false
  foreach ($item in $items) {
    if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and -not $item.Current.IsOffscreen -and $item.Current.Name.Contains($marker)) { $found = $true; break }
  }
  if (-not $found) { throw 'The TFO route marker is not visible in this chat' }
  foreach ($item in $items) {
    if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $item.Current.Name -eq 'Detener') { throw 'The chat is still running' }
    if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        -not $item.Current.IsOffscreen -and $item.Current.Name -match '^(Aprobar|Permitir|Rechazar|Aceptar|Approve|Allow|Reject|Accept)$') { throw 'An approval appears to be pending' }
    if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        -not $item.Current.IsOffscreen -and $item.Current.Name -match '^(Eliminar adjunto|Quitar archivo|Remove attachment)') { throw 'The composer has an attachment draft' }
  }
}
function Assert-Ready($window, $items, [string]$marker) {
  Assert-ChatReady $items $marker
  $editor = Get-EditorValue $items
  $draft = $editor.value.Trim()
  if ($draft -and $draft -ne 'Trabaja con ChatGPT') { throw 'The user has an existing draft' }
  return $editor
}
function Assert-EditorFocus($window, $editor) {
  if (-not $editor.Current.HasKeyboardFocus -or
      [TfoUnicodeInput]::GetForegroundWindow() -ne [IntPtr]$window.Current.NativeWindowHandle) {
    throw 'Keyboard focus changed; no send was attempted'
  }
}
function Get-PreparedComposer($window, [string]$marker, [string]$prompt, [string]$selectorName) {
  $items = Get-Items $window
  Assert-ChatReady $items $marker
  $selection = Find-Selector $items
  if (-not [string]::Equals($selection.Current.Name, $selectorName, [StringComparison]::Ordinal)) {
    throw 'Selection changed while preparing the prompt; no send was attempted'
  }
  $editor = Get-EditorValue $items
  Assert-EditorFocus $window $editor.element
  $value = [string]$editor.value
  $exact = [string]::Equals($value, $prompt, [StringComparison]::Ordinal)
  # The accessibility provider may still expose its placeholder or an input prefix
  # while Chromium processes SendInput. Observe only; never type the prompt again.
  $placeholder = [string]::IsNullOrWhiteSpace($value) -or $value.Trim() -ceq 'Trabaja con ChatGPT'
  if (-not $exact -and -not $placeholder -and -not $prompt.StartsWith($value, [StringComparison]::Ordinal)) {
    throw "Unexpected composer text (expected length $($prompt.Length), observed $($value.Length)); no send was attempted"
  }
  $buttons = @($items | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
    $_.Current.Name -eq 'Enviar' -and -not $_.Current.IsOffscreen
  })
  if ($buttons.Count -gt 1) { throw 'Multiple send buttons; no send was attempted' }
  $send = if ($buttons.Count -eq 1) { $buttons[0] } else { $null }
  return @{ ready = $exact -and $null -ne $send -and $send.Current.IsEnabled;
    send = $send; observedLength = $value.Length }
}
function Wait-PreparedComposer($window, [string]$marker, [string]$prompt, [string]$selectorName) {
  $stableReads = 0
  for ($read = 0; $read -lt 20; $read++) {
    Assert-RoutePendingDispatch
    $observation = Get-PreparedComposer $window $marker $prompt $selectorName
    if ($observation.ready) { $stableReads++ } else { $stableReads = 0 }
    if ($stableReads -ge 2) { return $observation }
    Start-Sleep -Milliseconds 100
  }
  throw "Composer did not confirm the exact prompt and enabled send button within 20 observations (expected length $($prompt.Length), last observed $($observation.observedLength)); no send was attempted"
}
function Send-PreparedPrompt($window, [string]$marker, [string]$prompt, [string]$selectorName) {
  $null = Wait-PreparedComposer $window $marker $prompt $selectorName
  Assert-RoutePendingDispatch
  # Re-read after the host guard: neither the text nor the selection may have changed.
  $fresh = Get-PreparedComposer $window $marker $prompt $selectorName
  if (-not $fresh.ready) { throw 'Composer changed before send; no send was attempted' }
  $script:tfoSendAttempted = $true
  $script:tfoPhase = 'invoking_send'
  $fresh.send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

$script:tfoPhase = 'preflight'
$script:tfoTextEntryAttempted = $false
$script:tfoSendAttempted = $false
try {
$root = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$candidates = @()
foreach ($window in $windows) {
  if ($window.Current.Name -eq 'ChatGPT' -and $window.Current.ClassName -eq 'Chrome_WidgetWin_1') { $candidates += $window }
}
if ($Mode -eq 'diagnose') {
  if ($candidates.Count -ne 1) {
    @{ status = 'unavailable'; windowCount = $candidates.Count; reason = 'Expected exactly one Codex Desktop window' } | ConvertTo-Json -Compress
    exit 0
  }
  $diagnosticItems = Get-Items $candidates[0]
  $selectorNames = @($diagnosticItems | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -match '^GPT-(6|5\.6|5\.5) ' } | ForEach-Object { $_.Current.Name })
  $editors = @($diagnosticItems | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $_.Current.Name -eq 'Trabaja con ChatGPT' })
  $busy = @($diagnosticItems | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq 'Detener' }).Count -gt 0
  @{ status = 'observed'; windowCount = 1; selectorNames = $selectorNames; editorCount = $editors.Count; uiStopButtonVisible = $busy;
    readinessChecked = $false; readyToSend = $null; readOnly = $true;
    explanation = 'Observation only. Readiness requires the route marker, completed source turn, empty composer and no approval; it is checked at dispatch.' } | ConvertTo-Json -Compress
  exit 0
}
if ($candidates.Count -ne 1) { throw "Expected one Codex Desktop window, found $($candidates.Count)" }
$window = $candidates[0]
$items = Get-Items $window
if ($Mode -eq 'probe') {
  Get-UiProbe $window $items $marker | ConvertTo-Json -Depth 5 -Compress
  exit 0
}
$editor = Assert-Ready $window $items $marker
$selection = Find-Selector $items
if (-not $request.prompt -or -not $request.model -or -not $request.reasoning) { throw 'Missing prompt or selection' }
if (-not $request.stateFile -or -not $request.sourceTurnId -or -not $request.nodeCommand) { throw 'Missing route state guard' }
function Assert-RoutePendingDispatch {
  $state = Get-Content -LiteralPath $request.stateFile -Raw | ConvertFrom-Json
  if ($request.runId -match '^flow_') {
    $join = $state.deferredJoin
    $main = @($state.lanes | Where-Object { $_.id -eq 'main' })
    $node = @($state.nodes | Where-Object { $_.id -eq $join.nodeId })
    if ($state.id -ne $request.runId -or $state.status -ne 'running' -or
        $join.status -ne 'dispatching' -or $join.transport -ne 'selected_join' -or
        $join.ownerPid -ne $request.ownerPid -or $join.sourceTurnId -ne $request.sourceTurnId -or
        $join.marker -ne $request.marker -or $state.mainThreadId -ne $request.threadId -or
        $main.Count -ne 1 -or $node.Count -ne 1 -or $main[0].threadId -ne $request.threadId -or
        $node[0].status -ne 'dispatching' -or $node[0].deliveryKind -ne 'selected_join' -or
        $node[0].visiblePrompt -cne $request.prompt -or
        $join.requestedSelection.model -ne $request.model -or $join.requestedSelection.reasoning -ne $request.reasoning) {
      throw 'The selected join changed before delivery'
    }
  } elseif ($state.id -ne $request.runId -or $state.status -ne 'dispatching' -or
      $state.dispatch.sending -ne $true -or $state.dispatch.sourceTurnId -ne $request.sourceTurnId -or
      $state.dispatch.stepId -ne $state.steps[$state.currentIndex].id) {
    throw 'The route was paused, cancelled or changed before delivery'
  }
  $guard = Join-Path $PSScriptRoot 'ui-send-guard.mjs'
  $guardResult = & $request.nodeCommand $guard $request.stateFile $request.runId $request.sourceTurnId $request.ownerPid 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Host readiness changed: $guardResult" }
}
Assert-RoutePendingDispatch
$script:tfoPhase = 'selecting'
$models = @{ 'gpt-6.1-sol' = 'GPT-6.1 Sol'; 'gpt-6-sol' = 'GPT-6 Sol'; 'gpt-6-astra' = 'GPT-6 Astra'; 'gpt-6-luna' = 'GPT-6 Luna';
  'gpt-5.6-sol' = 'GPT-5.6 Sol'; 'gpt-5.6-luna' = 'GPT-5.6 Luna' }
$efforts = @{ low = 1; medium = 2; high = 3; xhigh = 4; max = 5; ultra = 6 }
if (-not $models.ContainsKey($request.model) -or -not $efforts.ContainsKey($request.reasoning)) { throw 'Selection is not exposed by the accessible model picker' }

# Effort-only changes must not reselect the model or reset its current effort.
if (-not $selection.Current.Name.StartsWith($models[$request.model] + ' ')) {
try {
  $selection.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  Start-Sleep -Milliseconds 350
  $items = Get-Items $window
  $menuItem = Find-One $items 'Seleccionar modelo' ([System.Windows.Automation.ControlType]::MenuItem)
  $menuItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Milliseconds 250
  $items = Get-Items $window
  $modelOption = Find-One $items $models[$request.model] ([System.Windows.Automation.ControlType]::RadioButton)
  Assert-RoutePendingDispatch
  $modelOption.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
  Start-Sleep -Milliseconds 300
} finally {
  Close-ModelPicker $window
}
}

$items = Get-Items $window
$editor = Assert-Ready $window $items $marker
$selection = Find-Selector $items
if (-not $selection.Current.Name.StartsWith($models[$request.model])) { throw 'Model selection did not update the composer' }
Assert-RoutePendingDispatch
try {
  $selection.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  Start-Sleep -Milliseconds 400
  $items = Get-Items $window
  $power = Find-One $items 'Potencia' ([System.Windows.Automation.ControlType]::MenuItem)
  $level = $null
  foreach ($item in $items) {
    if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and
        $item.Current.Name -match '^(GPT-6|GPT-5\.6).* (\d+) de (\d+)\.$') {
      $level = @{ index = [int]$Matches[2]; total = [int]$Matches[3] }
      break
    }
  }
  if (-not $level) { throw 'Cannot read the current effort position' }
  $desired = $efforts[$request.reasoning]
  if ($desired -gt $level.total) { throw 'Requested effort is not available in the picker' }
  $power.SetFocus()
  [TfoUnicodeInput]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle) | Out-Null
  if ([TfoUnicodeInput]::GetForegroundWindow() -ne [IntPtr]$window.Current.NativeWindowHandle) { throw 'Another window has keyboard focus' }
  while ($level.index -ne $desired) {
    Assert-RoutePendingDispatch
    if ([TfoUnicodeInput]::GetForegroundWindow() -ne [IntPtr]$window.Current.NativeWindowHandle) { throw 'Keyboard focus changed while selecting effort' }
    $key = if ($level.index -gt $desired) { '{LEFT}' } else { '{RIGHT}' }
    [System.Windows.Forms.SendKeys]::SendWait($key)
    $level.index += if ($key -eq '{LEFT}') { -1 } else { 1 }
    Start-Sleep -Milliseconds 100
  }
  $items = Get-Items $window
  $verified = $false
  foreach ($item in $items) {
    if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and
        $item.Current.Name -match "^$([regex]::Escape($models[$request.model])).* $desired de $($level.total)\.$") { $verified = $true; break }
  }
  if (-not $verified) { throw 'The effort picker did not confirm the requested position' }
} finally {
  Close-ModelPicker $window
}

$items = Get-Items $window
$editor = Assert-Ready $window $items $marker
$selection = Find-Selector $items
if (-not (Test-RequestedSelection $selection.Current.Name $models[$request.model] $request.reasoning)) { throw 'The composer did not confirm the exact requested model and effort; no prompt was entered' }
$confirmedSelectorName = $selection.Current.Name
Assert-RoutePendingDispatch
$visiblePrompt = ([string]$request.prompt) -replace '[\r\n]+', '  '
[TfoUnicodeInput]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle) | Out-Null
if ([TfoUnicodeInput]::GetForegroundWindow() -ne [IntPtr]$window.Current.NativeWindowHandle) { throw 'Another window has keyboard focus' }
$editor.element.SetFocus()
Start-Sleep -Milliseconds 150
Assert-EditorFocus $window $editor.element
$script:tfoPhase = 'typing'
$script:tfoTextEntryAttempted = $true
[TfoUnicodeInput]::Type($visiblePrompt)
$script:tfoPhase = 'waiting_for_composer'
Send-PreparedPrompt $window $marker $visiblePrompt $confirmedSelectorName
@{ status = 'attempted'; selector = $confirmedSelectorName } | ConvertTo-Json -Compress
} catch {
  $failure = @{ phase = $script:tfoPhase; textEntryAttempted = $script:tfoTextEntryAttempted;
    sendAttempted = $script:tfoSendAttempted; error = $_.Exception.Message }
  [Console]::Error.WriteLine('TFO_UI_FAILURE:' + ($failure | ConvertTo-Json -Compress))
  exit 1
}
