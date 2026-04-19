import subprocess
import tempfile
import textwrap
from pathlib import Path
from ..agent.tools import build_tool_error_result

def make_python_interpreter(project_id: str, workspace_dir: Path):
    def python_interpreter(code: str):
        """
        Executes Python code in a restricted project workspace for data analysis or logic.
        
        Args:
            code: The Python code to execute.
        """
        # Security: Block common dangerous imports
        blocked = ["os", "subprocess", "sys", "shutil", "pty", "socket"]
        for module in blocked:
            if f"import {module}" in code or f"from {module}" in code:
                return build_tool_error_result(
                    tool_name="python_interpreter",
                    error_type="security_violation",
                    message=f"Importing module '{module}' is not allowed for security reasons.",
                    suggestion="Rewrite your code without using restricted system modules."
                )

        # Ensure workspace exists
        project_workspace = workspace_dir / project_id
        project_workspace.mkdir(parents=True, exist_ok=True)

        # Write code to a temp file in the workspace
        with tempfile.NamedTemporaryFile(suffix=".py", dir=project_workspace, delete=False, mode="w") as tmp:
            tmp.write(code)
            tmp_path = Path(tmp.name)

        try:
            result = subprocess.run(
                ["python3", str(tmp_path)],
                capture_output=True,
                text=True,
                timeout=15,
                cwd=project_workspace
            )
            
            output = result.stdout
            error = result.stderr
            
            if len(output) > 10000:
                output = output[:10000] + "\n... [Output Truncated]"

            return {
                "stdout": output,
                "stderr": error,
                "exit_code": result.returncode,
                "success": result.returncode == 0
            }
        except subprocess.TimeoutExpired:
            return build_tool_error_result(
                tool_name="python_interpreter",
                error_type="timeout",
                message="Code execution exceeded the 15-second timeout.",
                suggestion="Optimize your code or process data in smaller batches."
            )
        except Exception as e:
            return build_tool_error_result(
                tool_name="python_interpreter",
                error_type="execution_error",
                message=str(e),
                suggestion="Fix the syntax or logic error and try again."
            )
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

    return python_interpreter
