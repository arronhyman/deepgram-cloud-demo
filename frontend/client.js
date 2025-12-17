        // REPLACE THIS URL AFTER YOUR FIRST DEPLOY (See Step 6)
        const API_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws/"; 

        let socket;
        let mediaRecorder;

        document.getElementById('micBtn').addEventListener('click', async () => {
            const btn = document.getElementById('micBtn');
            if (btn.innerText === "Stop") {
                window.location.reload(); // Quick reset
                return;
            }

            // 1. Get Auth Token
            btn.innerText = "Connecting...";
            const authRes = await fetch(API_URL + "?route=auth", { method: 'POST' });
            const { key } = await authRes.json();

            // 2. Open Microphone
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

            // 3. Connect to Deepgram WebSocket
            socket = new WebSocket(`wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true`, [
                'token', key
            ]);

            socket.onopen = () => {
                btn.innerText = "Stop";
                btn.classList.add("active");
                
                mediaRecorder.addEventListener('dataavailable', event => {
                    if (event.data.size > 0 && socket.readyState === 1) {
                        socket.send(event.data);
                    }
                });
                mediaRecorder.start(250); // Send chunk every 250ms
            };

            socket.onmessage = async (message) => {
                const received = JSON.parse(message.data);
                const transcript = received.channel.alternatives[0].transcript;
                if (transcript && received.is_final) {
                    document.getElementById('transcript').innerText = `You: ${transcript}`;
                    
                    // 4. Send to Brain
                    const brainRes = await fetch(API_URL, {
                        method: 'POST',
                        body: JSON.stringify({ text: transcript })
                    });
                    const brainData = await brainRes.json();
                    document.getElementById('ai-response').innerText = `AI: ${brainData.response}`;
                    
                    // Optional: Add TTS playback here using Deepgram Speak API
                }
            };
        });