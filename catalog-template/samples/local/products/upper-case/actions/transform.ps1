#!/usr/bin/env pwsh
# upper-case's "transform" action: the text in capitals, using the same
# casing rules in every locale (ToUpperInvariant), so "straße" and "ödön"
# come out the same wherever it runs.
#
# Reads /platform/input/request.json, writes /platform/output/result.json:
# {"status": "succeeded", "outputs": {...}} or
# {"status": "failed", "error": {"code", "message", "retryable"}}.
$ErrorActionPreference = 'Stop'

$InputPath = '/platform/input/request.json'
$OutputPath = '/platform/output/result.json'
# result.json is limited to 4 KB, and the output carries the text back.
$MaxLength = 1000

function Write-Result([hashtable] $Result) {
    $Result | ConvertTo-Json -Compress -Depth 4 | Set-Content -Path $OutputPath -Encoding utf8NoBOM -NoNewline
}

function Exit-Failed([string] $Code, [string] $Message) {
    Write-Result @{ status = 'failed'; error = @{ code = $Code; message = $Message; retryable = $false } }
    exit 1
}

$request = Get-Content -Path $InputPath -Raw | ConvertFrom-Json -AsHashtable
$inputs = if ($request.ContainsKey('inputs') -and $request.inputs -is [hashtable]) { $request.inputs } else { @{} }
$text = $inputs['text']
if ($text -isnot [string] -or [string]::IsNullOrWhiteSpace($text)) {
    Exit-Failed 'MISSING_INPUT' 'inputs.text is required: the text to change.'
}
# Counted in code points, the way the other language samples count.
$length = @($text.EnumerateRunes()).Count
if ($length -gt $MaxLength) {
    Exit-Failed 'TEXT_TOO_LONG' "inputs.text is $length characters; the limit is $MaxLength."
}

Write-Output "upper-cased $length characters"
Write-Result @{ status = 'succeeded'; outputs = @{ text = $text.ToUpperInvariant(); language = 'PowerShell' } }
exit 0
