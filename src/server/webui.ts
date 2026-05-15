/**
 * morph — Web UI Assets
 */

export const INDEX_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>morph MISSION CONTROL</title>
    <style>
        body { background: #0a0a0a; color: #d1d1d1; font-family: 'JetBrains Mono', monospace; margin: 0; padding: 40px; }
        .card { background: #141414; border: 1px solid #222; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
        .status-running { border-left: 4px solid #00aaff; }
        .status-done { border-left: 4px solid #00ff00; }
        h1 { color: #fff; border-bottom: 1px solid #222; padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
        button { background: #00ff00; color: #000; border: none; padding: 10px 20px; font-weight: bold; font-family: inherit; cursor: pointer; border-radius: 4px; display: none; }
        button.active { display: block; }
        button:hover { background: #00cc00; }
    </style>
</head>
<body>
    <h1>
        morph MISSION CONTROL
        <button id="approve-btn" onclick="approvePhase()">APPROVE & CONTINUE</button>
    </h1>
    <div id="status">CONNECTING...</div>
    <div id="content" style="white-space: pre-wrap; font-size: 0.9em; margin-top: 20px; color: #aaa;"></div>
    <script>
        let currentPhase = "idle";
        const ws = new WebSocket("ws://" + location.host);
        
        ws.onmessage = (e) => {
            const state = JSON.parse(e.data);
            currentPhase = state.phase;
            document.getElementById('content').innerText = JSON.stringify(state, null, 2);
            document.getElementById('status').innerText = "SYSTEMS ONLINE | PHASE: " + state.phase.toUpperCase();
            
            // Show approve button if we are likely waiting at a gate
            const btn = document.getElementById('approve-btn');
            // We assume if state has output but phase hasn't transitioned, it's waiting for approval
            btn.className = "active";
        };

        async function approvePhase() {
            try {
                await fetch('/api/approve', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phase: currentPhase })
                });
                document.getElementById('approve-btn').innerText = "APPROVED ✓";
                setTimeout(() => { document.getElementById('approve-btn').innerText = "APPROVE & CONTINUE"; }, 2000);
            } catch (err) {
                console.error(err);
            }
        }
    </script>
</body>
</html>
`;
