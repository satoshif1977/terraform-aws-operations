"""
lambda 配下の各 Lambda ディレクトリは同名の index.py を持つ。
テスト収集時に「テストファイル → index モジュール」のマッピングを記録し、
テスト実行前に正しいモジュールを sys.modules["index"] に復元する。
"""

import os
import sys

# テストファイルパス → 対応する index モジュール
_test_file_to_module: dict[str, object] = {}


def pytest_itemcollected(item) -> None:
    """収集完了したテストアイテムに、収集時点の index モジュールを紐付ける。"""
    fspath = str(item.fspath)
    if fspath in _test_file_to_module:
        return

    test_dir = os.path.dirname(fspath)
    index_file = os.path.normpath(os.path.join(test_dir, "index.py"))
    if not os.path.exists(index_file):
        return

    module = sys.modules.get("index")
    if module is None:
        return

    module_file = os.path.normpath(getattr(module, "__file__", ""))
    if module_file == index_file:
        _test_file_to_module[fspath] = module


def pytest_runtest_setup(item) -> None:
    """各テスト実行前に、そのテストが属するディレクトリの index モジュールを復元する。"""
    fspath = str(item.fspath)
    correct_module = _test_file_to_module.get(fspath)
    if correct_module is not None:
        sys.modules["index"] = correct_module
        test_dir = os.path.dirname(fspath)
        if test_dir not in sys.path:
            sys.path.insert(0, test_dir)
