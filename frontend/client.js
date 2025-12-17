const API_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws/"; 

let socket;
let mediaRecorder;
let deepgramKey; 

// STATE MANAGEMENT
let isAiSpeaking = false; 

document.getElementById('micBtn').addEventListener('click', async () => {
    const btn = document.getElementById('micBtn');
    
    // Toggle Logic
    if (btn.classList.contains("active")) {
        stopEverything();
        return;
    }

    // 1. Get Auth Token
    btn.innerText = "Connecting...";
    try {
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

    // 3. Connect to Deepgram (STT)
    const dgParams = "model=nova-2&smart_format=true&sentiment=true&punctuate=true&endpointing=300";
    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${dgParams}`, [
        'token', deepgramKey
    ]);

    socket.onopen = () => {
        btn.innerText = "Stop";
        btn.classList.add("active");
        document.getElementById('transcript').innerText = "Listening...";
        
        mediaRecorder.addEventListener('dataavailable', event => {
            if (event.data.size > 0 && socket.readyState === 1 && !isAiSpeaking) {
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
            const sentiment = alternative.sentiment;
            
            if (transcript && transcript.trim().length > 0) {
                document.getElementById('transcript').innerHTML = 
                    `You (${sentiment}): ${transcript}`;
                
                // 4. Send to Bedrock
                document.getElementById('ai-response').innerText = "AI thinking...";
                
                // Lock the mic immediately
                isAiSpeaking = true; 
                
                handleAiProcessing(transcript, sentiment);
            }
        }
    };
    
    socket.onclose = () => {
        if (btn.classList.contains("active")) stopEverything();
    };
});

function stopEverything() {
    const btn = document.getElementById('micBtn');
    if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if(socket) socket.close();
    
    btn.innerText = "Start Demo";
    btn.classList.remove("active");
    document.getElementById('transcript').innerText = "Session ended.";
    isAiSpeaking = false;
}

// ==========================================
// $$$ THIS SECTION IS COMPLETELY NEW $$$
// ==========================================

async function handleAiProcessing(text, sentiment) {
    try {
        const brainRes = await fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify({ text, sentiment })
        });
        const brainData = await brainRes.json();
        const fullText = brainData.response;
        
        document.getElementById('ai-response').innerText = `AI: ${fullText}`;
        
        // 1. SPLIT TEXT INTO SENTENCES
        const sentences = fullText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [fullText];

        // 2. PARALLEL DOWNLOADS (The Speed Fix)
        // usage of .map() starts fetching ALL audio clips immediately
        const audioPromises = sentences.map(sentence => {
            const trimmed = sentence.trim();
            if (trimmed.length === 0) return null;
            return fetchDeepgramAudio(trimmed);
        });

        // 3. SEQUENTIAL PLAYBACK (The Order Fix)
        for (const promise of audioPromises) {
            if (!promise) continue;
            const blob = await promise; // Wait for download to finish
            if (blob) {
                await playAudioBlob(blob); // Wait for audio to finish playing
            }
        }
        
        // 4. UNMUTE MIC (Only after loop ends)
        if (document.getElementById('micBtn').classList.contains("active")) {
            isAiSpeaking = false;
            console.log("AI finished speaking. Mic open.");
        }
        
    } catch (e) {
        console.error("AI Error:", e);
        isAiSpeaking = false; 
    }
}

// Helper to play audio and wait for it to end
function playAudioBlob(blob) {
    return new Promise((resolve) => {
        const btn = document.getElementById('micBtn');
        if (!btn.classList.contains("active")) {
            resolve();
            return;
        }

        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);
        
        audio.onended = () => resolve();
        audio.play().catch(e => {
            console.error("Play Error:", e);
            resolve();
        });
    });
}

async function fetchDeepgramAudio(text) {
    if (!deepgramKey) return null;
    
    // Optimized for speed (WAV format)
    const url = "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=24000";
    
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Token ${deepgramKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ text: text })
        });
        return await response.blob();
    } catch (e) {
        console.error("TTS Error:", e);
        return null;
    }
}