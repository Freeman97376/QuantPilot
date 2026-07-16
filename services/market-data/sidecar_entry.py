import os

import uvicorn

from quantpilot_market_data.api import create_app


def main() -> None:
    """Packaged entry point with an explicit ASGI import for PyInstaller."""
    uvicorn.run(
        create_app(),
        host=os.getenv("QUANTPILOT_MARKET_HOST", "127.0.0.1"),
        port=int(os.getenv("QUANTPILOT_MARKET_PORT", "8000")),
        reload=False,
    )


if __name__ == "__main__":
    main()
