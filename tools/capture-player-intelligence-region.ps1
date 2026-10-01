param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [ValidateRange(5, 300)]
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RppClipboardSequence {
    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();
}
'@

$initialSequence = [RppClipboardSequence]::GetClipboardSequenceNumber()
Start-Process 'ms-screenclip:'
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)

while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
    if ([RppClipboardSequence]::GetClipboardSequenceNumber() -eq $initialSequence) {
        continue
    }
    try {
        if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
            continue
        }
        $image = [System.Windows.Forms.Clipboard]::GetImage()
    }
    catch {
        # The clipboard can be locked briefly by the snipping UI; keep waiting within the same bounded capture.
        continue
    }
    if ($null -eq $image) {
        continue
    }
    try {
        $image.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $image.Dispose()
    }
    exit 0
}

throw "No screen region was captured within $TimeoutSeconds seconds."
