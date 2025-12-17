import json
import os
import boto3
import requests
from datetime import datetime

dynamodb = boto3.resource("dynamodb")
bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")
secrets = boto3.client("secretsmanager")


def cors_headers():
    return {
        "Access-Control-Allow-Origin": "https://deepgram.lesuto.com",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    }


def get_deepgram_key():
    secret_arn = os.environ.get("SECRETS_ARN")
    if not secret_arn:
        return None

    response = secrets.get_secret_value(SecretId=secret_arn)
    return json.loads(response["SecretString"]).get("api_key")


def lambda_handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method")

    if method == "OPTIONS":
        return {
            "statusCode": 200,
            "headers": cors_headers(),
            "body": ""
        }

    query = event.get("queryStringParameters") or {}

    body = {}
    if event.get("body"):
        try:
            body = json.loads(event["body"])
        except Exception:
            pass

    action = query.get("route") or body.get("action", "chat")

    # ---------- AUTH ----------
    if action == "auth":
        key = get_deepgram_key()
        if not key:
            return {
                "statusCode": 500,
                "headers": cors_headers(),
                "body": json.dumps({"error": "Deepgram key missing"})
            }

        return {
            "statusCode": 200,
            "headers": cors_headers(),
            "body": json.dumps({"key": key})
        }

    # ---------- TTS (STREAMING) ----------
    if action == "tts":
        text = body.get("text")
        if not text:
            return {
                "statusCode": 400,
                "headers": cors_headers(),
                "body": json.dumps({"error": "No text"})
            }

        dg_key = get_deepgram_key()
        url = "https://api.deepgram.com/v1/speak"
        params = {
            "model": "aura-asteria-en",
            "encoding": "opus",
            "container": "webm"
        }

        dg_response = requests.post(
            url,
            headers={
                "Authorization": f"Token {dg_key}",
                "Content-Type": "application/json"
            },
            params=params,
            json={"text": text},
            stream=True
        )

        return {
            "statusCode": 200,
            "headers": {
                **cors_headers(),
                "Content-Type": "audio/webm"
            },
            "body": dg_response.content,
            "isBase64Encoded": False
        }

    # ---------- CHAT ----------
    user_text = body.get("text")
    sentiment = body.get("sentiment", "neutral")

    prompt = (
        f'User Input: "{user_text}"\n'
        f"Detected Sentiment: {sentiment}\n\n"
        "Respond in 1–2 short sentences.\n"
    )

    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 120,
        "messages": [{"role": "user", "content": prompt}]
    }

    response = bedrock.invoke_model(
        modelId="anthropic.claude-3-haiku-20240307-v1:0",
        body=json.dumps(payload)
    )

    result = json.loads(response["body"].read())
    ai_text = result["content"][0]["text"]

    return {
        "statusCode": 200,
        "headers": cors_headers(),
        "body": json.dumps({"response": ai_text})
    }