"""Standalone verification — runs the exact pattern the user provided.
Usage:  python verify_model.py
Output: PONG and the model identity, or the actual error.
"""
import os
os.environ.setdefault("AZURE_OPENAI_ENDPOINT", "https://veilixdocumentextraction.openai.azure.com/")
os.environ.setdefault("AZURE_OPENAI_API_KEY", "replace-with-your-key")
os.environ.setdefault("AZURE_OPENAI_DEPLOYMENT", "gpt-5-mini")

from openai import AzureOpenAI

client = AzureOpenAI(
    api_key=os.getenv("AZURE_OPENAI_API_KEY"),
    api_version="2024-02-15-preview",
    azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
)

def main() -> int:
    print(f"Endpoint   : {os.getenv('AZURE_OPENAI_ENDPOINT')}")
    print(f"Deployment : {os.getenv('AZURE_OPENAI_DEPLOYMENT')}")
    print(f"API version: 2024-02-15-preview")
    print("Pinging deployment…")
    try:
        response = client.chat.completions.create(
            model=os.getenv("AZURE_OPENAI_DEPLOYMENT"),
            messages=[
                {"role": "system", "content": "You are a health-check. Reply with the single word PONG."},
                {"role": "user", "content": "ping"},
            ],
        )
        reply = (response.choices[0].message.content or "").strip()
        print(f"✓ Deployment reachable. Reply: {reply!r}")
        return 0
    except Exception as e:
        print(f"✗ Verification FAILED: {type(e).__name__}: {e}")
        print("\nThings to check:")
        print("  - Is AZURE_OPENAI_DEPLOYMENT exactly the name shown in the Azure portal?")
        print("  - Is the API key valid (paste fresh from the portal)?")
        print("  - Does your network allow https outbound to *.openai.azure.com?")
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
