import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("PowerShell selector lookup survives regex captures and rejects ambiguous controls", () => {
  // Execute the real function in isolation: no desktop enumeration or UI mutation.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:TFO_TEST_BRIDGE, [ref]$null, [ref]$null)
$definition = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Find-Selector'}, $true)
Invoke-Expression $definition.Extent.Text
$selectionCheck = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-RequestedSelection'}, $true)
Invoke-Expression $selectionCheck.Extent.Text
if (-not (Test-RequestedSelection 'GPT-6 Astra Ligero' 'GPT-6 Astra' 'low')) {throw 'Low selection rejected'}
if (Test-RequestedSelection 'GPT-6 Astra Muy alto' 'GPT-6 Astra' 'low') {throw 'Wrong effort accepted'}
if (Test-RequestedSelection 'GPT-6 Luna Ligero' 'GPT-6 Astra' 'low') {throw 'Wrong model accepted'}
$item = [pscustomobject]@{Current=[pscustomobject]@{Name='GPT-6 Astra Ligero';ControlType=[System.Windows.Automation.ControlType]::Button;BoundingRectangle=[pscustomobject]@{Width=200}}}
$found = Find-Selector @($item)
if ($found.Current.Name -ne 'GPT-6 Astra Ligero') {throw 'Wrong selector'}
foreach ($label in @('GPT-6.1 Sol Medio', 'GPT-6 Sol Medio')) {
  $item.Current.Name = $label
  if ((Find-Selector @($item)).Current.Name -ne $label) {throw 'Sol selector not recognized'}
}
if (-not (Test-RequestedSelection 'GPT-6.1 Sol Medio' 'GPT-6.1 Sol' 'medium')) {throw 'Sol 6.1 rejected'}
if (Test-RequestedSelection 'GPT-6 Sol Medio' 'GPT-6.1 Sol' 'medium') {throw 'Old Sol accepted as 6.1'}
$rejected = $false
try { Find-Selector @($item,$item) | Out-Null } catch { if ($_.Exception.Message -match 'found 2') {$rejected=$true} else {throw} }
if (-not $rejected) {throw 'Ambiguous selectors accepted'}
foreach ($name in @('Test-PickerOpen','Close-ModelPicker')) {
  $fn = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
  Invoke-Expression $fn.Extent.Text
}
$script:reads=0; $script:escapes=0
$menu = [pscustomobject]@{Current=[pscustomobject]@{Name='Potencia';ControlType=[System.Windows.Automation.ControlType]::MenuItem;IsOffscreen=$false}}
function Get-Items($window) { $script:reads++; if ($script:reads -le 2) {return @($menu)}; return @($item) }
function Send-PickerEscape($window) { $script:escapes++ }
function Start-Sleep {param($Milliseconds)}
Close-ModelPicker $null
if ($script:escapes -ne 1 -or $script:reads -ne 3) {throw 'Picker closure did not wait for the recreated composer'}
function Get-Items($window) {return @($menu)}
$failed=$false
try {Close-ModelPicker $null} catch {if ($_.Exception.Message -match 'did not close') {$failed=$true} else {throw}}
if (-not $failed -or $script:escapes -ne 2) {throw 'Stuck picker should stop after exactly one Escape'}
'ok'
`;
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide:true, encoding:"utf8", timeout:10000,
    env:{...process.env,TFO_TEST_BRIDGE:fileURLToPath(new URL("../ui-bridge.ps1",import.meta.url))},
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"ok");
});

test("UI request preserves Unicode even when the console uses the OEM code page", () => {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::GetEncoding(437)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:TFO_TEST_BRIDGE, [ref]$null, [ref]$null)
$fn = $ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Read-TfoRequestJson'}, $true)
Invoke-Expression $fn.Extent.Text
$request = ConvertFrom-Json (Read-TfoRequestJson)
[Console]::Write($request.prompt)
`;
  const prompt = '[Enviado por TFO · cola prueba · paso 1/1] No hagas nada más. ñ ¿sí? 😀';
  const result = spawnSync('pwsh', ['-NoProfile','-NonInteractive','-Command',script], {
    input:JSON.stringify({prompt}), encoding:'utf8', windowsHide:true, timeout:10000,
    env:{...process.env,TFO_TEST_BRIDGE:fileURLToPath(new URL('../ui-bridge.ps1',import.meta.url))},
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,prompt);
});
