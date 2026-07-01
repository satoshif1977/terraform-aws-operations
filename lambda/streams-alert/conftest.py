import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.modules.pop("index", None)
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
