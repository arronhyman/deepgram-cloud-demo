// YOUR SPECIFIC LAMBDA URL
const API_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws/"; 

let socket;
let mediaRecorder;
let deepgramKey;
let ttsSocket = null;
let ttsAudioContext = null;
let isSpeaking = false;

document.getElementById('micBtn').addEventListener('click', async () => {
    const btn = document.getElementById('micBtn');
    
    // Toggle Logic
    if (btn.classList.contains("active")) {
        // Stop Everything
        if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        if(socket) socket.close();
        
        btn.innerText = "Start Demo";
        btn.classList.remove("active");
        document.getElementById('transcript').innerText = "Session ended.";
        return;
    }

    // 1. Get Auth Token
    btn.innerText = "Connecting...";
    try { 
        // We use ?route=auth to hit the specific logic in Python
        const authRes = await fetch(API_URL + "?route=auth");
        const authData = await authRes.json();
        
        if (!authData.key) throw new Error(authData.error || "No Key Returned");
        deepgramKey = authData.key;
    } catch (e) {
        alert("Auth Error: " + e.message);
        btn.innerText = "Start Demo";
        return;
    }

    // 2. Open Microphone
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        alert("Microphone Error: " + e.message);
        return;
    }
    
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    // 3. Connect to Deepgram (Nova-2 + Sentiment + Smart Format)
    const dgParams = "model=nova-2&smart_format=true&sentiment=true&punctuate=true";
    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${dgParams}`, [
        'token', deepgramKey
    ]);

    socket.onopen = () => {
        btn.innerText = "Stop";
        btn.classList.add("active");
        document.getElementById('transcript').innerText = "Listening...";
        
        mediaRecorder.addEventListener('dataavailable', event => {
            if (event.data.size > 0 && socket.readyState === 1) {
                socket.send(event.data);
            }
        });
        mediaRecorder.start(250);
    };

    socket.onmessage = async (message) => {
        const received = JSON.parse(message.data);
        const alternative = received.channel?.alternatives[0];
        
        if (alternative && received.is_final) {
            const transcript = alternative.transcript;
            const sentiment = alternative.sentiment; // e.g., "positive", "negative"
            
            if (transcript) {
                document.getElementById('transcript').innerHTML = 
                    `You (${sentiment}): ${transcript}`;
                
                // 4. Send to Bedrock (Brain)
                document.getElementById('ai-response').innerText = "AI thinking...";
                
                const brainRes = await fetch(API_URL, {
                    method: 'POST',
                    body: JSON.stringify({ 
                        text: transcript,
                        sentiment: sentiment 
                    })
                });
                const brainData = await brainRes.json();
                const aiResponse = brainData.response;
                
                document.getElementById('ai-response').innerText = `AI: ${aiResponse}`;
                
                // 5. Speak Result (Deepgram Aura)
                await speakWithDeepgram(aiResponse);
            }
        }
    };
    
    socket.onclose = () => {
        if (btn.classList.contains("active")) {
             btn.click(); // Trigger stop UI cleanup
        }
    };
});

// TTS Function
async function speakWithDeepgram(text) {
    if (!deepgramKey || isSpeaking) return;  // Prevent overlap
    
    isSpeaking = true;
    document.getElementById('ai-response').innerText = `AI (speaking): ${text}`;

    // Close any old socket
    if (ttsSocket) ttsSocket.close();

    ttsSocket = new WebSocket(
        `wss://api.deepgram.com/v1/speak?model=aura-asteria-en`,
        ['token', deepgramKey]
    );

    ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)();

    ttsSocket.onopen = () => {
        // Send the full text (for short responses, this is fine)
        ttsSocket.send(JSON.stringify({ type: 'Speak', text }));
        
        // Optional: Flush to force immediate processing
        ttsSocket.send(JSON.stringify({ type: 'Flush' }));
    };

    ttsSocket.onmessage = async (event) => {
        if (event.data instanceof Blob) {
            const arrayBuffer = await event.data.arrayBuffer();
            const audioBuffer = await ttsAudioContext.decodeAudioData(arrayBuffer);
            
            const source = ttsAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ttsAudioContext.destination);
            source.start(0);
        }
    };

    ttsSocket.onclose = () => {
        isSpeaking = false;
        if (ttsAudioContext) ttsAudioContext.close();
    };

    ttsSocket.onerror = (err) => {
        console.error('TTS WS Error:', err);
        isSpeaking = false;
    };
}