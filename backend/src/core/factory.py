from typing import Dict, Type, Any
from .interfaces import BaseProvider

class ProviderFactory:
    """
    Factory class to instantiate LLM providers.
    Uses a registry pattern to map string identifiers to Provider classes.
    """
    _registry: Dict[str, Type[BaseProvider]] = {}

    @classmethod
    def register(cls, provider_name: str):
        """
        A decorator to register a provider class with a string identifier.
        Usage:
            @ProviderFactory.register("openai")
            class OpenAIAdapter(BaseProvider): ...
        """
        def inner_wrapper(wrapped_class: Type[BaseProvider]) -> Type[BaseProvider]:
            if provider_name in cls._registry:
                raise ValueError(f"Provider '{provider_name}' is already registered.")
            if not issubclass(wrapped_class, BaseProvider):
                raise TypeError(f"Class '{wrapped_class.__name__}' must inherit from BaseProvider.")
            
            cls._registry[provider_name] = wrapped_class
            return wrapped_class
        return inner_wrapper

    @classmethod
    def create(cls, provider_name: str, model_name: str, **kwargs: Any) -> BaseProvider:
        """
        Instantiates and returns a provider by its registered name.
        """
        if provider_name not in cls._registry:
            registered = ", ".join(cls._registry.keys())
            raise ValueError(
                f"Provider '{provider_name}' is not registered. "
                f"Available providers: {registered}"
            )
            
        provider_class = cls._registry[provider_name]
        return provider_class(model_name=model_name, **kwargs)

# Convenience function for easy imports
def get_provider(model_string: str, **kwargs: Any) -> BaseProvider:
    """
    Instantiates a provider using a combined string format: 'provider/model_name'.
    Example: 'openai/gpt-4o' or 'ollama/llama3.1'.
    If no provider prefix is given, it defaults to 'openai'.
    """
    if "/" in model_string:
        provider_name, model_name = model_string.split("/", 1)
    else:
        # Default fallback if no provider is explicitly stated
        provider_name = "openai"
        model_name = model_string
        
    return ProviderFactory.create(provider_name, model_name, **kwargs)
