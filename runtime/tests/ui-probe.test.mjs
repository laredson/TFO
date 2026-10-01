import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('UI preflight requires a visible marker and composer bounds and has no input or scroll actions', () => {
 const script=`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:TFO_TEST_BRIDGE,[ref]$null,[ref]$null)
foreach($name in @('Get-UiProbe','Assert-Ready','Assert-ChatReady','Get-Items','Get-EditorValue','Find-One','Find-Selector')) {
 $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 $mutations=$fn.FindAll({param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Value -in @('Invoke','SetFocus','Scroll','ScrollIntoView','SendWait','Type','Select','Expand','Collapse','SetForegroundWindow')},$true)
 if($mutations.Count){throw "Mutation in read-only preflight: $name"}
 Invoke-Expression $fn.Extent.Text
}
function Rect($x,$y,$w,$h){return [pscustomobject]@{X=$x;Y=$y;Left=$x;Top=$y;Width=$w;Height=$h;Right=$x+$w;Bottom=$y+$h}}
$window=[pscustomobject]@{Current=[pscustomobject]@{BoundingRectangle=(Rect 0 0 1200 900)}}
$marker=[pscustomobject]@{Current=[pscustomobject]@{ControlType=[System.Windows.Automation.ControlType]::Text;Name='queue_test';IsOffscreen=$false;BoundingRectangle=(Rect 400 500 200 30)}}
$editor=[pscustomobject]@{Current=[pscustomobject]@{IsOffscreen=$false;BoundingRectangle=(Rect 300 700 700 100)}}
$selector=[pscustomobject]@{Current=[pscustomobject]@{Name='GPT-6 Astra Ultra';IsOffscreen=$false;BoundingRectangle=(Rect 800 820 150 30)}}
function Get-EditorValue($items){return @{element=$editor;value='Trabaja con ChatGPT'}}
function Find-Selector($items){return $selector}
$r=Get-UiProbe $window @() 'queue_test'
if($r.status -ne 'awaiting_render' -or $r.markerCount -ne 0){throw 'Missing marker accepted'}
$marker.Current.BoundingRectangle=Rect 400 -100 200 30
$r=Get-UiProbe $window @($marker) 'queue_test'
if($r.status -ne 'awaiting_render' -or $r.markerCount -ne 1){throw 'Off-window marker accepted'}
$marker.Current.BoundingRectangle=Rect 400 500 200 30
$r=Get-UiProbe $window @($marker) 'queue_test'
if($r.status -ne 'ready' -or $r.layout.editor[1] -ne 700){throw 'Visible layout rejected'}
$editor.Current.BoundingRectangle=Rect 300 1000 700 100
$r=Get-UiProbe $window @($marker) 'queue_test'
if($r.status -ne 'awaiting_render' -or $r.reason -ne 'composer_not_visible'){throw 'Off-window editor accepted'}
'ok'
`;
 const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:10000,env:{...process.env,TFO_TEST_BRIDGE:fileURLToPath(new URL('../ui-bridge.ps1',import.meta.url))}});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'ok');
});
