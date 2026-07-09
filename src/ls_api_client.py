"""
Label Studio REST API 客户端

封装与 Label Studio API 的通信，用于：
- 获取项目列表
- 获取未完成任务列表
- 获取任务详情/状态
- 验证 API Token 连通性
"""

from __future__ import annotations

import json
import time
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional, Tuple


class LSApiError(Exception):
    """Label Studio API 调用错误"""
    pass


class LSApiClient:
    """Label Studio REST API 轻量客户端（零第三方依赖）"""

    def __init__(self, api_url: str, api_token: str):
        self.api_url = api_url.rstrip("/")
        self.api_token = api_token

    # ==================== 底层 HTTP 请求 ====================

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Token {self.api_token}",
            "Content-Type": "application/json",
        }

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        body: Optional[Dict[str, Any]] = None,
    ) -> Tuple[int, Any]:
        """发起 HTTP 请求，返回 (status_code, parsed_json)"""
        url = f"{self.api_url}{path}"
        if params:
            qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items() if v is not None)
            url = f"{url}?{qs}"

        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(url, data=data, method=method)
        for k, v in self._headers().items():
            req.add_header(k, v)

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read().decode("utf-8")
                parsed = json.loads(raw) if raw else {}
                return resp.status, parsed
        except urllib.error.HTTPError as e:
            error_body = ""
            try:
                error_body = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            raise LSApiError(f"HTTP {e.code}: {e.reason} — {error_body[:200]}")
        except urllib.error.URLError as e:
            raise LSApiError(f"连接失败: {e.reason}")

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        _, data = self._request("GET", path, params=params)
        return data

    def _patch(self, path: str, body: Dict[str, Any]) -> Any:
        _, data = self._request("PATCH", path, body=body)
        return data

    # ==================== 连通性检测 ====================

    def ping(self) -> Dict[str, Any]:
        """测试 API 连通性，返回服务器信息"""
        try:
            data = self._get("/api/projects/", params={"page": 1, "page_size": 1})
            return {"ok": True, "data": data}
        except LSApiError as e:
            return {"ok": False, "error": str(e)}

    # ==================== 项目 ====================

    def list_projects(self, page: int = 1, page_size: int = 50) -> Dict[str, Any]:
        """获取项目列表"""
        return self._get("/api/projects/", params={"page": page, "page_size": page_size})

    def get_project(self, project_id: int) -> Dict[str, Any]:
        """获取单个项目详情"""
        return self._get(f"/api/projects/{project_id}/")

    # ==================== 任务 ====================

    def list_tasks(
        self,
        project_id: int,
        page: int = 1,
        page_size: int = 50,
        only_uncompleted: bool = False,
    ) -> Dict[str, Any]:
        """获取项目下的任务列表"""
        params: Dict[str, Any] = {
            "project": project_id,
            "page": page,
            "page_size": page_size,
        }
        if only_uncompleted:
            params["completed"] = "0"  # LS API 用 completed=0 表示未完成
        return self._get("/api/tasks/", params=params)

    def get_task(self, task_id: int) -> Dict[str, Any]:
        """获取单个任务详情"""
        return self._get(f"/api/tasks/{task_id}/")

    def get_next_uncompleted_task(
        self, project_id: int, current_task_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        获取当前项目中的下一个未完成任务。
        策略：从当前任务之后的第一页开始搜索未完成的任务。

        返回下一个未完成任务的 dict，或 None（已全部完成）。
        """
        page = 1
        page_size = 100

        while True:
            data = self.list_tasks(
                project_id=project_id,
                page=page,
                page_size=page_size,
                only_uncompleted=False,  # 先全部拉，自已过滤
            )

            tasks = data.get("results") or data.get("tasks") or []
            if not tasks:
                break

            for task in tasks:
                tid = task.get("id")
                completed = task.get("completed") or task.get("is_labeled", False)
                if tid and tid != current_task_id and not completed:
                    return task

            # 如果当前页没有更多了
            if not data.get("next"):
                break
            page += 1

        return None

    def get_task_completed_status(self, task_id: int) -> bool:
        """检查任务是否已完成"""
        task = self.get_task(task_id)
        if not task:
            return False
        return bool(task.get("completed") or task.get("is_labeled", False))

    def get_annotations(self, task_id: int) -> List[Dict[str, Any]]:
        """获取任务的标注列表"""
        data = self._get(f"/api/tasks/{task_id}/")
        return data.get("annotations", [])


def create_client_from_settings(settings_path: str) -> Optional[LSApiClient]:
    """从 settings.json 文件路径创建客户端"""
    import json as _json
    from pathlib import Path

    p = Path(settings_path)
    if not p.exists():
        return None

    cfg = _json.loads(p.read_text(encoding="utf-8"))
    ls_cfg = cfg.get("label_studio", {})
    api_url = ls_cfg.get("api_url", "")
    api_token = ls_cfg.get("api_token", "")

    if not api_url or not api_token:
        return None

    return LSApiClient(api_url, api_token)


# ==================== 直接测试 ====================

if __name__ == "__main__":
    import os
    import sys

    # 尝试从 settings.json 读取配置进行测试
    settings_candidates = [
        os.path.join(os.path.dirname(__file__), "..", "config", "settings.json"),
        os.path.join(os.path.dirname(__file__), "..", "..", "config", "settings.json"),
    ]

    client = None
    for sp in settings_candidates:
        sp = os.path.abspath(sp)
        if os.path.exists(sp):
            client = create_client_from_settings(sp)
            if client:
                print(f"📄 从配置加载: {sp}")
                break

    if not client:
        print("❌ 未找到有效配置")
        sys.exit(1)

    print(f"🔗 连接到: {client.api_url}")
    print()

    # 测试 1: 连通性
    print("=" * 50)
    print("📡 测试 1: API 连通性")
    print("=" * 50)
    result = client.ping()
    if result.get("ok"):
        print("✅ 连接成功！")
        data = result.get("data", {})
        if isinstance(data, dict):
            count = data.get("count", "?")
            print(f"   项目总数: {count}")
    else:
        print(f"❌ 连接失败: {result.get('error')}")
        sys.exit(1)

    print()

    # 测试 2: 项目列表
    print("=" * 50)
    print("📋 测试 2: 项目列表")
    print("=" * 50)
    projects = client.list_projects(page=1, page_size=20)
    results = projects.get("results") or projects.get("projects") or []
    if results:
        print(f"   共 {len(results)} 个项目（本页）:")
        for p in results:
            pid = p.get("id", "?")
            title = p.get("title", p.get("name", "未命名"))
            print(f"   📁 #{pid} {title}")
    else:
        print(f"   项目列表为空或格式未识别")
        print(f"   原始数据前 500 字符: {json.dumps(projects, ensure_ascii=False)[:500]}")

    print()

    # 测试 3: 选择第一个项目，查看任务
    if results:
        first = results[0]
        pid = first.get("id")
        title = first.get("title", first.get("name", "未命名"))
        print("=" * 50)
        print(f"📝 测试 3: 项目 #{pid}「{title}」的任务列表")
        print("=" * 50)
        tasks_data = client.list_tasks(project_id=pid, page=1, page_size=10)
        tasks = tasks_data.get("results") or tasks_data.get("tasks") or []
        if tasks:
            completed_count = sum(1 for t in tasks if t.get("completed") or t.get("is_labeled"))
            uncompleted_count = len(tasks) - completed_count
            print(f"   本页共 {len(tasks)} 个任务（已完成 {completed_count}，未完成 {uncompleted_count}）")
            print(f"   前 3 个任务预览:")
            for t in tasks[:3]:
                tid = t.get("id", "?")
                completed = t.get("completed") or t.get("is_labeled", False)
                print(f"   🔹 Task #{tid} 完成: {completed}")
                print(f"      data 字段: {json.dumps(t.get('data', {}), ensure_ascii=False)[:120]}")
        else:
            print(f"   任务列表为空")
            print(f"   原始数据前 500 字符: {json.dumps(tasks_data, ensure_ascii=False)[:500]}")

        print()

        # 测试 4: 找下一个未完成任务
        print("=" * 50)
        print("🔍 测试 4: 找下一个未完成任务")
        print("=" * 50)
        next_task = client.get_next_uncompleted_task(project_id=pid, current_task_id=0)
        if next_task:
            nid = next_task.get("id", "?")
            print(f"   第一个未完成任务: #{nid}")
        else:
            print("   未找到未完成任务（或全部已完成）")

        # 测试 5: 任务详情
        if tasks:
            first_task = tasks[0]
            tid = first_task.get("id")
            print()
            print("=" * 50)
            print(f"📄 测试 5: Task #{tid} 详情")
            print("=" * 50)
            detail = client.get_task(tid)
            print(f"   ID: {detail.get('id')}")
            print(f"   Completed: {detail.get('completed')}")
            print(f"   is_labeled: {detail.get('is_labeled')}")
            annotations = detail.get("annotations", [])
            print(f"   标注数: {len(annotations)}")
            print(f"   data: {json.dumps(detail.get('data', {}), ensure_ascii=False)[:200]}")

    print()
    print("=" * 50)
    print("✅ 测试完成")
