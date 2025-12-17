import json
import os
import boto3
from datetime import datetime

# AWS clients
dynamodb = boto3.resource("dynamodb")
bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")
secrets = boto3.client("secretsmanager")


def get_deepgram_key():
    try:
        secret_arn = os.environ.get("SECRETS_ARN")
        if not secret_arn:
            return None

        response = secrets.get_secret_value(SecretId=secret_arn)
        secret = json.loads(response["SecretString"])
        return secret.get("api_key")
    except Exception as e:
        print("Secret error:", e)
        return None


def lambda_handler(event, context):
    headers = {
        "Content-Type": "application/json"
    }

    method = event.get("requestContext", {}).get("http", {}).get("method")

    if method == "OPTIONS":
        return {
            "statusCode": 200,
            "headers": headers
        }

    query_params = event.get("queryStringParameters") or {}

    body = {}
    if event.get("body"):
        try:
            body = json.loads(event["body"])
        except Exception:
            body = {}

    action = (
        query_params.get("route")
        or query_params.get("action")
        or body.get("action", "chat")
    )

    if action == "auth":
        api_key = get_deepgram_key()

        if not api_key:
            return {
                "statusCode": 500,
                "headers": headers,
                "body": json.dumps({"error": "Deepgram API key not configured"})
            }

        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({"key": api_key})
        }

    user_text = body.get("text", "")
    user_sentiment = body.get("sentiment", "neutral")
    session_id = body.get("session_id", "demo_session")

    if not user_text:
        return {
            "statusCode": 400,
            "headers": headers,
            "body": json.dumps({"error": "No text provided"})
        }

    prompt = (
        f'User Input: "{user_text}"\n'
        f'Detected Sentiment: {user_sentiment}\n\n'
        "You are a helpful voice assistant.\n"
        "1. Answer clearly.\n"
        "2. Match the user's sentiment.\n"
        "3. Keep it under 2 sentences.\n"
    )

    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 150,
        "messages": [
            {"role": "user", "content": prompt}
        ]
    }

    try:
        response = bedrock.invoke_model(
            modelId="anthropic.claude-3-haiku-20240307-v1:0",
            body=json.dumps(payload)
        )

        result = json.loads(response["body"].read())
        ai_text = result["content"][0]["text"]

        table_name = os.environ.get("TABLE_NAME")
        if table_name:
            dynamodb.Table(table_name).put_item(
                Item={
                    "session_id": session_id,
                    "timestamp": datetime.utcnow().isoformat(),
                    "user": user_text,
                    "sentiment": user_sentiment,
                    "ai": ai_text
                }
            )

        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({"response": ai_text})
        }

    except Exception as e:
        print("Bedrock error:", e)
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"error": str(e)})
        }