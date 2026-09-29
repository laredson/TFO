import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('PowerShell waits for exact rendered text and sends once; stale, changed and blocked composers never send', () => {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:TFO_TEST_BRIDGE,[ref]$null,[ref]$null)
foreach($name in @('Assert-ChatReady','Get-PreparedComposer','Wait-PreparedComposer','Send-PreparedPrompt')) {
 $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
function Control($name,$type) {return [pscustomobject]@{Current=[pscustomobject]@{Name=$name;ControlType=$type;IsOffscreen=$false;IsEnabled=$true}}}
$script:invoker=[pscustomobject]@{}
$script:invoker | Add-Member ScriptMethod Invoke { $script:sends++; if($script:invokeThrows){throw 'Ambiguous invocation'} }
$script:send=Control 'Enviar' ([System.Windows.Automation.ControlType]::Button)
$script:send | Add-Member ScriptMethod GetCurrentPattern {param($pattern) return $script:invoker}
function Get-Items($window) {
 $index=[Math]::Min($script:reads,$script:frames.Count-1)
 $script:frame=$script:frames[$index]; $script:reads++
 $items=@()
 if(-not $script:frame.noMarker){$items+=Control 'queue_test' ([System.Windows.Automation.ControlType]::Text)}
 if($script:frame.block){$items+=Control $script:frame.block ([System.Windows.Automation.ControlType]::Button)}
 if($script:frame.send -ne 'missing') {
  $script:send.Current.IsEnabled=$script:frame.send -ne 'disabled'
  $items+=$script:send
  if($script:frame.send -eq 'duplicate'){$items+=$script:send}
 }
 return $items
}
function Get-EditorValue($items) {return @{value=$script:frame.value;element=$null}}
function Find-Selector($items) {return [pscustomobject]@{Current=[pscustomobject]@{Name=if($script:frame.selector){$script:frame.selector}else{'GPT-6 Astra Ligero'}}}}
function Assert-EditorFocus($window,$editor) {if($script:frame.badFocus){throw 'Focus changed'}}
function Assert-RoutePendingDispatch { $script:guards++; if($script:cancelAt -eq $script:guards){throw 'Route cancelled'} }
function Start-Sleep {param($Milliseconds) $script:waits++}
function Reset($frames) {
 $script:frames=$frames; $script:reads=0; $script:sends=0; $script:guards=0; $script:waits=0
 $script:cancelAt=0; $script:invokeThrows=$false; $script:tfoSendAttempted=$false
}
$prompt='[TFO · prueba] hola más 😀'
$exact=@{value=$prompt}
Reset @(@{value="\nTrabaja con ChatGPT";send='missing'},@{value='[TFO ·';send='disabled'},@{value=$prompt;send='disabled'},$exact,$exact,$exact)
Send-PreparedPrompt $null 'queue_test' $prompt 'GPT-6 Astra Ligero'
if($script:sends -ne 1 -or $script:reads -ne 6 -or -not $script:tfoSendAttempted){throw 'Did not wait for stable rendered composer'}
foreach($bad in @(
 @{value='[TFO · prueba] HOLA más 😀'},
 @{value=$prompt+' '},
 @{value='user draft'},
 @{value=$prompt;selector='GPT-6 Astra Ultra'},
 @{value=$prompt;block='Detener'},
 @{value=$prompt;block='Aprobar'},
 @{value=$prompt;block='Eliminar adjunto'},
 @{value=$prompt;noMarker=$true},
 @{value=$prompt;badFocus=$true},
 @{value=$prompt;send='duplicate'}
)) {
 Reset @($bad)
 $failed=$false
 try{Send-PreparedPrompt $null 'queue_test' $prompt 'GPT-6 Astra Ligero'}catch{$failed=$true}
 if(-not $failed -or $script:sends -ne 0 -or $script:tfoSendAttempted){throw 'Unsafe composer reached send'}
}
foreach($slow in @(@{value="\nTrabaja con ChatGPT"},@{value=$prompt;send='disabled'},@{value=$prompt;send='missing'})) {
 Reset @($slow)
 $failed=$false
 try{Send-PreparedPrompt $null 'queue_test' $prompt 'GPT-6 Astra Ligero'}catch{if($_.Exception.Message -match '20 observations'){$failed=$true}else{throw}}
 if(-not $failed -or $script:reads -ne 20 -or $script:sends -ne 0){throw 'Render wait was not bounded'}
}
Reset @($exact,$exact,@{value='changed after host guard'})
try{Send-PreparedPrompt $null 'queue_test' $prompt 'GPT-6 Astra Ligero';throw 'Expected failure'}catch{if($_.Exception.Message -notmatch 'Unexpected composer') {throw}}
if($script:sends -ne 0){throw 'Used stale send button'}
Reset @($exact); $script:cancelAt=2
try{Send-PreparedPrompt $null 'queue_test' $prompt 'GPT-6 Astra Ligero';throw 'Expected failure'}catch{if($_.Exception.Message -notmatch 'cancelled'){throw}}
if($script:sends -ne 0){throw 'Sent after cancellation'}
Reset @($exact); $script:invokeThrows=$true
try{Send-PreparedPrompt $null 'queue_test' $prompt 'GPT-6 Astra Ligero';throw 'Expected failure'}catch{if($_.Exception.Message -notmatch 'Ambiguous invocation'){throw}}
if($script:sends -ne 1 -or -not $script:tfoSendAttempted){throw 'Ambiguous send was retried or hidden'}
'ok'
`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{
    windowsHide:true,encoding:'utf8',timeout:10000,
    env:{...process.env,TFO_TEST_BRIDGE:fileURLToPath(new URL('../ui-bridge.ps1',import.meta.url))},
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),'ok');
});
